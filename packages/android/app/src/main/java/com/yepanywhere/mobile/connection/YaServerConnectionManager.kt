package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import com.yepanywhere.mobile.security.YaSecurityClientLifecycle
import com.yepanywhere.mobile.security.YaSecurityClientRevokedException
import com.yepanywhere.mobile.experimental.CONVERSATION_API_REVISION
import com.yepanywhere.mobile.experimental.ConversationQuery
import com.yepanywhere.mobile.experimental.SimpleClientContract
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

enum class YaConnectionPhase {
    IDLE,
    CONNECTING,
    CONNECTED,
    RETRYING,
    REAUTHENTICATION_REQUIRED,
    REVOKED,
    FAILED,
}

data class YaConnectionState(
    val phase: YaConnectionPhase,
    val routeId: String? = null,
    val retryAttempt: Int = 0,
    val errorMessage: String? = null,
)

data class YaApiResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: Any?,
)

class YaApiException(val response: YaApiResponse) :
    IllegalStateException("YA API returned status ${response.status}")

class YaConnectionUnavailableException(message: String, cause: Throwable? = null) :
    IllegalStateException(message, cause)

class YaSubscriptionOverflowException :
    IllegalStateException("Native subscription consumer fell behind")

data class YaSubscriptionEvent(
    val eventType: String,
    val eventId: String?,
    val data: Any?,
)

class YaSubscription internal constructor(
    val events: Flow<YaSubscriptionEvent>,
    private val release: () -> Unit,
) : Closeable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (closed.compareAndSet(false, true)) release()
    }
}

class YaConnectionLease internal constructor(
    private val manager: YaServerConnectionManager,
    internal val id: String,
) : Closeable {
    private val released = AtomicBoolean(false)

    suspend fun request(
        method: String,
        path: String,
        body: Any? = null,
        headers: Map<String, String> = emptyMap(),
    ): YaApiResponse {
        check(!released.get()) { "Connection lease is released" }
        return manager.request(id, method, path, body, headers)
    }

    suspend fun subscribe(
        channel: String,
        sessionId: String? = null,
        projectId: String? = null,
        provider: String? = null,
        lastEventId: String? = null,
        wantsLiveDeltas: Boolean? = null,
    ): YaSubscription {
        check(!released.get()) { "Connection lease is released" }
        return manager.subscribe(
            leaseId = id,
            channel = channel,
            sessionId = sessionId,
            projectId = projectId,
            provider = provider,
            lastEventId = lastEventId,
            wantsLiveDeltas = wantsLiveDeltas,
        )
    }

    suspend fun releaseAndAwait() {
        if (released.compareAndSet(false, true)) manager.releaseLease(id)
    }

    suspend fun subscribeConversation(subscriptionId: String, query: ConversationQuery): YaSubscription {
        check(!released.get()) { "Connection lease is released" }
        SimpleClientContract.decodeId(subscriptionId)
        return manager.subscribe(
            leaseId = id,
            channel = "/api/experimental/conversation/subscribe",
            sessionId = null,
            projectId = null,
            provider = null,
            lastEventId = null,
            wantsLiveDeltas = null,
            conversation = query,
            bindingId = subscriptionId,
        )
    }

    override fun close() {
        if (released.compareAndSet(false, true)) manager.releaseLeaseAsync(id)
    }
}

class YaServerConnectionManager(
    private val profileId: String,
    private val repository: YaPairedServerRepository,
    private val connector: YaProfileConnector,
    private val securityClients: YaSecurityClientLifecycle? = null,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
    private val retryDelaysMs: List<Long> = listOf(250, 1_000, 3_000),
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val mutex = Mutex()
    private val leases = mutableMapOf<String, MutableSet<String>>()
    private val pendingRequests = mutableMapOf<String, CompletableDeferred<YaApiResponse>>()
    private val subscriptions = mutableMapOf<String, SubscriptionRecord>()
    private var connection: YaRoutedTransport? = null
    private var connectionJob: Job? = null
    private var connectionGeneration = 0L
    private var connectionReady = CompletableDeferred<Unit>()
    private val mutableState = MutableStateFlow(YaConnectionState(YaConnectionPhase.IDLE))

    val state: StateFlow<YaConnectionState> = mutableState.asStateFlow()

    init {
        require(retryDelaysMs.all { it >= 0 })
    }

    suspend fun acquire(): YaConnectionLease {
        val leaseId = UUID.randomUUID().toString()
        mutex.withLock {
            leases[leaseId] = mutableSetOf()
            startConnectionIfNeededLocked()
        }
        return YaConnectionLease(this, leaseId)
    }

    internal suspend fun request(
        leaseId: String,
        method: String,
        path: String,
        body: Any?,
        headers: Map<String, String>,
    ): YaApiResponse {
        require(method in SUPPORTED_METHODS) { "Unsupported YA API method" }
        require(path.startsWith("/") && !path.startsWith("//")) {
            "YA API path must be origin-relative"
        }
        require(headers.keys.none { it.equals("Authorization", ignoreCase = true) }) {
            "Native secure requests do not accept an Authorization header"
        }
        val transport = ensureConnected(leaseId)
        val requestId = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<YaApiResponse>()
        val requestHeaders = headers.filterKeys { supplied ->
            supplied.lowercase() !in MANAGED_REQUEST_HEADERS
        } + mapOf("Content-Type" to "application/json", "X-Yep-Anywhere" to "true")
        val message = JSONObject()
            .put("type", "request")
            .put("id", requestId)
            .put("method", method)
            .put("path", if (path.startsWith("/api")) path else "/api$path")
            .put(
                "headers",
                JSONObject(requestHeaders),
            )
        if (body != null) message.put("body", JSONObject.wrap(body))

        mutex.withLock {
            check(leases.containsKey(leaseId)) { "Connection lease is released" }
            check(connection?.transport === transport) { "Native connection changed before request send" }
            pendingRequests[requestId] = deferred
            try {
                transport.send(message)
            } catch (error: Throwable) {
                pendingRequests.remove(requestId)
                throw error
            }
        }

        return try {
            val response = withTimeout(REQUEST_TIMEOUT_MS) { deferred.await() }
            if (response.status >= 400) throw YaApiException(response)
            response
        } finally {
            mutex.withLock { pendingRequests.remove(requestId) }
        }
    }

    internal suspend fun subscribe(
        leaseId: String,
        channel: String,
        sessionId: String?,
        projectId: String?,
        provider: String?,
        lastEventId: String?,
        wantsLiveDeltas: Boolean?,
        conversation: ConversationQuery? = null,
        bindingId: String? = null,
    ): YaSubscription {
        require(channel in SUPPORTED_SUBSCRIPTION_CHANNELS ||
            (channel == "/api/experimental/conversation/subscribe" && conversation != null && bindingId != null))
        if (conversation != null) SimpleClientContract.decodeConversationQuery(conversation.toJson())
        require(channel != "session" || !sessionId.isNullOrBlank())
        require(channel != "session-watch" || (!sessionId.isNullOrBlank() && !projectId.isNullOrBlank()))
        val transport = ensureConnected(leaseId)
        val subscriptionId = bindingId ?: UUID.randomUUID().toString()
        val eventChannel = Channel<YaSubscriptionEvent>(SUBSCRIPTION_BUFFER_SIZE)
        val record = SubscriptionRecord(
            id = subscriptionId,
            leaseId = leaseId,
            channel = channel,
            sessionId = sessionId,
            projectId = projectId,
            provider = provider,
            lastEventId = lastEventId,
            wantsLiveDeltas = wantsLiveDeltas,
            events = eventChannel,
            conversation = conversation,
        )
        mutex.withLock {
            val owned = checkNotNull(leases[leaseId]) { "Connection lease is released" }
            check(subscriptionId !in subscriptions) { "Subscription identity already in use" }
            check(connection?.transport === transport) {
                "Native connection changed before subscription send"
            }
            subscriptions[subscriptionId] = record
            owned += subscriptionId
            try {
                transport.send(record.subscribeMessage())
            } catch (error: Throwable) {
                subscriptions.remove(subscriptionId)
                owned -= subscriptionId
                eventChannel.close(error)
                throw error
            }
        }
        return YaSubscription(eventChannel.receiveAsFlow()) {
            scope.launch { closeSubscription(subscriptionId) }
        }
    }

    internal fun releaseLeaseAsync(leaseId: String) {
        scope.launch { releaseLease(leaseId) }
    }

    internal suspend fun releaseLease(leaseId: String) {
        val subscriptionsToClose = mutex.withLock {
            leases.remove(leaseId)?.toList().orEmpty()
        }
        subscriptionsToClose.forEach { closeSubscription(it) }

        var job: Job? = null
        var transport: YaMessageTransport? = null
        mutex.withLock {
            if (leases.isEmpty()) {
                connectionGeneration += 1
                job = connectionJob
                connectionJob = null
                transport = connection?.transport
                connection = null
                failPendingLocked(YaConnectionUnavailableException("No native connection owner"))
                connectionReady.completeExceptionally(
                    YaConnectionUnavailableException("No native connection owner"),
                )
                mutableState.value = YaConnectionState(YaConnectionPhase.IDLE)
            }
        }
        job?.cancel()
        transport?.cancel()
        job?.join()
    }

    suspend fun shutdownAndAwait() {
        val leaseIds = mutex.withLock { leases.keys.toList() }
        leaseIds.forEach { releaseLease(it) }
        scope.cancel()
    }

    override fun close() {
        scope.launch { shutdownAndAwait() }
    }

    private suspend fun ensureConnected(leaseId: String): YaMessageTransport {
        while (true) {
            val waitForConnection = mutex.withLock {
                check(leases.containsKey(leaseId)) { "Connection lease is released" }
                connection?.transport?.let { return it }
                startConnectionIfNeededLocked()
                connectionReady
            }
            waitForConnection.await()
        }
    }

    private fun startConnectionIfNeededLocked() {
        if (leases.isEmpty() || connection != null || connectionJob != null) return
        connectionGeneration += 1
        val generation = connectionGeneration
        connectionReady = CompletableDeferred()
        connectionJob = scope.launch { runConnectionLoop(generation, connectionReady) }
    }

    private suspend fun runConnectionLoop(
        generation: Long,
        ready: CompletableDeferred<Unit>,
    ) {
        var failureCount = 0
        try {
            while (currentCoroutineContext().isActive && hasDemand(generation)) {
                setState(
                    generation,
                    YaConnectionState(
                        phase = if (failureCount == 0) {
                            YaConnectionPhase.CONNECTING
                        } else {
                            YaConnectionPhase.RETRYING
                        },
                        retryAttempt = failureCount,
                    ),
                )
                var routed: YaRoutedTransport? = null
                try {
                    val snapshot = repository.snapshot(profileId)
                        ?: throw YaConnectionUnavailableException("Paired server profile was removed")
                    val stored = snapshot.resumeCredential
                    if (stored == null || !stored.isEligibleAt(nowEpochMs())) {
                        if (stored != null) repository.clearCredential(profileId)
                        throw ReauthenticationRequired()
                    }
                    routed = connector.resume(snapshot.profile, stored.credential)
                    securityClients?.ensure(snapshot.profile, routed.transport)
                    val connectedAt = maxOf(nowEpochMs(), stored.establishedAtEpochMs)
                    repository.recordSuccessfulAuthentication(
                        profileId = profileId,
                        routeId = routed.route.id,
                        resumeCredential = stored.copy(lastResumedAtEpochMs = connectedAt),
                        connectedAtEpochMs = connectedAt,
                    )
                    installConnection(generation, routed)
                    restoreSubscriptions(routed.transport)
                    ready.complete(Unit)
                    receiveMessages(generation, routed)
                    throw YaConnectionUnavailableException("Native secure connection ended")
                } catch (error: CancellationException) {
                    throw error
                } catch (error: ReauthenticationRequired) {
                    failTerminal(
                        generation,
                        ready,
                        YaConnectionPhase.REAUTHENTICATION_REQUIRED,
                        "Sign in again to resume this server",
                        error,
                    )
                    return
                } catch (error: YaAllRoutesRejectedException) {
                    repository.clearCredential(profileId)
                    failTerminal(
                        generation,
                        ready,
                        YaConnectionPhase.REAUTHENTICATION_REQUIRED,
                        "The saved session was rejected; sign in again",
                        error,
                    )
                    return
                } catch (error: YaSecurityClientRevokedException) {
                    failTerminal(
                        generation,
                        ready,
                        YaConnectionPhase.REVOKED,
                        "This Android device was revoked; pair it again explicitly",
                        error,
                    )
                    return
                } catch (error: Throwable) {
                    clearConnection(generation, routed?.transport, error)
                    if (!hasDemand(generation)) return
                    if (failureCount >= retryDelaysMs.size) {
                        failTerminal(
                            generation,
                            ready,
                            YaConnectionPhase.FAILED,
                            "Could not connect to the paired server",
                            error,
                        )
                        return
                    }
                    val delayMs = retryDelaysMs[failureCount]
                    failureCount += 1
                    setState(
                        generation,
                        YaConnectionState(
                            phase = YaConnectionPhase.RETRYING,
                            retryAttempt = failureCount,
                            errorMessage = "Connection lost; retrying",
                        ),
                    )
                    delay(delayMs)
                } finally {
                    routed?.transport?.cancel()
                }
            }
        } finally {
            mutex.withLock {
                if (connectionGeneration == generation) {
                    connection = null
                    connectionJob = null
                    if (leases.isEmpty()) {
                        mutableState.value = YaConnectionState(YaConnectionPhase.IDLE)
                    }
                }
            }
        }
    }

    private suspend fun installConnection(generation: Long, routed: YaRoutedTransport) {
        mutex.withLock {
            check(connectionGeneration == generation && leases.isNotEmpty()) {
                "Native connection no longer has an owner"
            }
            connection = routed
            mutableState.value = YaConnectionState(
                phase = YaConnectionPhase.CONNECTED,
                routeId = routed.route.id,
            )
        }
    }

    private suspend fun restoreSubscriptions(transport: YaMessageTransport) {
        val messages = mutex.withLock { subscriptions.values.map(SubscriptionRecord::subscribeMessage) }
        messages.forEach(transport::send)
    }

    private suspend fun receiveMessages(generation: Long, routed: YaRoutedTransport) {
        while (currentCoroutineContext().isActive) {
            handleMessage(generation, routed.transport, routed.transport.receive())
        }
    }

    private suspend fun handleMessage(
        generation: Long,
        transport: YaMessageTransport,
        message: JSONObject,
    ) {
        val type = message.optString("type")
        when (type) {
            "response" -> {
                val id = message.getString("id")
                val response = message.toApiResponse()
                mutex.withLock {
                    if (connectionGeneration != generation || connection?.transport !== transport) return
                    val pending = pendingRequests.remove(id)
                    if (pending != null) {
                        pending.complete(response)
                    } else if (response.status >= 400) {
                        val subscription = subscriptions.remove(id)
                        if (subscription != null) {
                            leases[subscription.leaseId]?.remove(id)
                            subscription.events.close(YaApiException(response))
                        }
                    }
                    Unit
                }
            }

            "event" -> {
                val id = message.getString("subscriptionId")
                val overflowed = mutex.withLock {
                    if (connectionGeneration != generation || connection?.transport !== transport) return
                    val subscription = subscriptions[id] ?: return
                    val eventId = message.optNullableString("eventId")
                    if (eventId != null) subscription.lastEventId = eventId
                    subscription.events.trySend(
                        YaSubscriptionEvent(
                            eventType = message.getString("eventType"),
                            eventId = eventId,
                            data = message.optNullable("data"),
                        ),
                    ).isFailure
                }
                if (overflowed) closeSubscription(id, YaSubscriptionOverflowException())
            }
        }
    }

    private suspend fun clearConnection(
        generation: Long,
        transport: YaMessageTransport?,
        error: Throwable,
    ) {
        mutex.withLock {
            if (connectionGeneration != generation) return
            if (transport == null || connection?.transport === transport) connection = null
            failPendingLocked(YaConnectionUnavailableException("Native connection was lost", error))
            failConversationsLocked(error)
        }
    }

    private suspend fun failTerminal(
        generation: Long,
        ready: CompletableDeferred<Unit>,
        phase: YaConnectionPhase,
        message: String,
        error: Throwable,
    ) {
        mutex.withLock {
            if (connectionGeneration != generation) return
            connection = null
            mutableState.value = YaConnectionState(phase = phase, errorMessage = message)
            failPendingLocked(YaConnectionUnavailableException(message, error))
            failConversationsLocked(error)
            ready.completeExceptionally(YaConnectionUnavailableException(message, error))
        }
    }

    private suspend fun closeSubscription(
        subscriptionId: String,
        error: Throwable? = null,
    ) {
        val removed = mutex.withLock {
            val record = subscriptions.remove(subscriptionId) ?: return
            leases[record.leaseId]?.remove(subscriptionId)
            val active = connection?.transport
            if (active != null) {
                runCatching {
                    active.send(
                        JSONObject()
                            .put("type", "unsubscribe")
                            .put("subscriptionId", subscriptionId),
                    )
                }
            }
            record
        }
        removed.events.close(error)
    }

    private suspend fun hasDemand(generation: Long): Boolean {
        return mutex.withLock { connectionGeneration == generation && leases.isNotEmpty() }
    }

    private suspend fun setState(generation: Long, state: YaConnectionState) {
        mutex.withLock {
            if (connectionGeneration == generation) mutableState.value = state
        }
    }

    private fun failPendingLocked(error: Throwable) {
        pendingRequests.values.forEach { it.completeExceptionally(error) }
        pendingRequests.clear()
    }

    /** Conversations restart at sequence zero; never replay their old binding. */
    private fun failConversationsLocked(error: Throwable) {
        subscriptions.values.filter { it.conversation != null }.forEach { record ->
            subscriptions.remove(record.id)
            leases[record.leaseId]?.remove(record.id)
            record.events.close(YaConnectionUnavailableException("Conversation disconnected", error))
        }
    }

    private data class SubscriptionRecord(
        val id: String,
        val leaseId: String,
        val channel: String,
        val sessionId: String?,
        val projectId: String?,
        val provider: String?,
        var lastEventId: String?,
        val wantsLiveDeltas: Boolean?,
        val events: Channel<YaSubscriptionEvent>,
        val conversation: ConversationQuery? = null,
    ) {
        fun subscribeMessage(): JSONObject {
            conversation?.let {
                return JSONObject().put("type", "subscribe").put("subscriptionId", id)
                    .put("channel", channel).put("apiRevision", CONVERSATION_API_REVISION)
                    .put("query", it.toJson())
            }
            return JSONObject()
                .put("type", "subscribe")
                .put("subscriptionId", id)
                .put("channel", channel)
                .putOptional("sessionId", sessionId)
                .putOptional("projectId", projectId)
                .putOptional("provider", provider)
                .putOptional("lastEventId", lastEventId)
                .putOptional("wantsLiveDeltas", wantsLiveDeltas)
        }
    }

    private class ReauthenticationRequired : IllegalStateException()

    companion object {
        private val SUPPORTED_METHODS = setOf("GET", "POST", "PUT", "DELETE", "PATCH")
        private val SUPPORTED_SUBSCRIPTION_CHANNELS = setOf("session", "activity", "session-watch")
        private val MANAGED_REQUEST_HEADERS = setOf("content-type", "x-yep-anywhere")
        private const val REQUEST_TIMEOUT_MS = 30_000L
        private const val SUBSCRIPTION_BUFFER_SIZE = 64
    }
}

private fun ConversationQuery.toJson(): JSONObject = JSONObject()
    .put("sessionId", sessionId).put("maxMessages", maxMessages)
    .put("anchorMessageId", anchorMessageId ?: JSONObject.NULL)

private fun JSONObject.toApiResponse(): YaApiResponse {
    val headersObject = optJSONObject("headers")
    val headers = if (headersObject == null) {
        emptyMap()
    } else {
        buildMap {
            headersObject.keys().forEach { key -> put(key, headersObject.getString(key)) }
        }
    }
    return YaApiResponse(
        status = getInt("status"),
        headers = headers,
        body = optNullable("body"),
    )
}

private fun JSONObject.optNullable(name: String): Any? {
    return if (!has(name) || isNull(name)) null else get(name)
}

private fun JSONObject.optNullableString(name: String): String? {
    return if (!has(name) || isNull(name)) null else getString(name)
}

private fun JSONObject.putOptional(name: String, value: Any?): JSONObject {
    if (value != null) put(name, value)
    return this
}
