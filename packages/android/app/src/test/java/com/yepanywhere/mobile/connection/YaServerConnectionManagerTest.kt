package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.experimental.ConversationQuery
import com.yepanywhere.mobile.experimental.CONVERSATION_API_REVISION
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaPairedServerSnapshot
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import com.yepanywhere.mobile.security.YaSecurityClientLifecycle
import com.yepanywhere.mobile.security.YaSecurityClientRevokedException
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class YaServerConnectionManagerTest {
    @Test
    fun multiplexesRequestsAndClosesOnlyAfterTheFinalLease() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val firstLease = manager.acquire()
        val secondLease = manager.acquire()

        val request = async {
            firstLease.request("GET", "/sessions")
        }
        val requestMessage = transport.awaitSent("request")
        transport.incoming.send(
            JSONObject()
                .put("type", "response")
                .put("id", requestMessage.getString("id"))
                .put("status", 200)
                .put("body", JSONObject().put("sessions", 2)),
        )
        val response = request.await()
        assertEquals(200, response.status)
        assertEquals(2, (response.body as JSONObject).getInt("sessions"))

        firstLease.releaseAndAwait()
        assertFalse(transport.cancelled)
        secondLease.releaseAndAwait()
        assertTrue(transport.cancelled)
        assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)
        manager.shutdownAndAwait()
    }

    @Test
    fun restoresSubscriptionsAcrossABoundedReconnect() = runBlocking {
        val fixture = Fixture()
        val firstTransport = FakeTransport(fixture.credential)
        val secondTransport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(firstTransport))
        fixture.connector.results.send(Result.success(secondTransport))
        val manager = fixture.manager(retryDelaysMs = listOf(0))
        val lease = manager.acquire()
        val subscription = lease.subscribe(channel = "activity")
        val firstSubscribe = firstTransport.awaitSent("subscribe")
        val subscriptionId = firstSubscribe.getString("subscriptionId")
        val firstEvent = async { subscription.events.first() }
        firstTransport.incoming.send(
            JSONObject()
                .put("type", "event")
                .put("subscriptionId", subscriptionId)
                .put("eventType", "session_updated")
                .put("eventId", "4")
                .put("data", JSONObject().put("sessionId", "session-1")),
        )
        assertEquals("4", firstEvent.await().eventId)

        firstTransport.incoming.close(IllegalStateException("network lost"))
        val restored = secondTransport.awaitSent("subscribe")
        assertEquals(subscriptionId, restored.getString("subscriptionId"))
        assertEquals("4", restored.getString("lastEventId"))
        assertEquals(YaConnectionPhase.CONNECTED, manager.state.value.phase)

        subscription.close()
        secondTransport.awaitSent("unsubscribe")
        lease.releaseAndAwait()
        assertTrue(secondTransport.cancelled)
        manager.shutdownAndAwait()
    }

    @Test
    fun conversationBindingsCloseOnDisconnectWhileActivityReplays() = runBlocking {
        val fixture = Fixture()
        val first = FakeTransport(fixture.credential)
        val second = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(first))
        fixture.connector.results.send(Result.success(second))
        val manager = fixture.manager(retryDelaysMs = listOf(0))
        val lease = manager.acquire()
        try {
            lease.subscribe(channel = "activity")
            val conversation = lease.subscribeConversation("binding-one", ConversationQuery("session", 20, null))
            val frame = first.sent.first { it.optString("subscriptionId") == "binding-one" }
            assertEquals("/api/experimental/conversation/subscribe", frame.getString("channel"))
            assertEquals(CONVERSATION_API_REVISION, frame.getString("apiRevision"))
            assertEquals(20, frame.getJSONObject("query").getInt("maxMessages"))
            val closed = async { runCatching { conversation.events.first() }.exceptionOrNull() }
            first.incoming.close(IllegalStateException("Disconnected"))
            val restored = second.awaitSent("subscribe")
            assertEquals("activity", restored.getString("channel"))
            assertNotNull(withTimeout(2000) { closed.await() })
            assertFalse(second.sent.any { it.optString("subscriptionId") == "binding-one" })
            val fresh = lease.subscribeConversation("binding-two", ConversationQuery("session", 40, "anchor"))
            val event = async { fresh.events.first() }
            second.incoming.send(JSONObject().put("type", "event").put("subscriptionId", "binding-two")
                .put("eventType", "snapshot").put("data", JSONObject().put("sequence", 0)))
            assertEquals(0, (withTimeout(2000) { event.await() }.data as JSONObject).getInt("sequence"))
        } finally { lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun clearsARejectedCredentialAndRequiresVisibleReauthentication() = runBlocking {
        val fixture = Fixture()
        fixture.connector.results.send(Result.failure(YaAllRoutesRejectedException()))
        val manager = fixture.manager(retryDelaysMs = emptyList())
        val lease = manager.acquire()

        val error = runCatching { lease.request("GET", "/sessions") }.exceptionOrNull()
        assertNotNull(error)
        assertEquals(YaConnectionPhase.REAUTHENTICATION_REQUIRED, manager.state.value.phase)
        assertTrue(fixture.repository.credentialCleared)
        assertEquals(1, fixture.connector.resumeCalls)

        lease.releaseAndAwait()
        manager.shutdownAndAwait()
    }

    @Test
    fun exposesRevocationAsADistinctTerminalConnectionState() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        val emitRevocation = CompletableDeferred<Unit>()
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager(
            securityClients = YaSecurityClientLifecycle { _, activeTransport ->
                assertTrue(activeTransport === transport)
                emitRevocation.await()
                throw YaSecurityClientRevokedException(
                    "44444444-4444-4444-8444-444444444444",
                )
            },
        )
        val lease = manager.acquire()

        val request = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { lease.request("GET", "/sessions") }
        }
        emitRevocation.complete(Unit)
        val error = request.await().exceptionOrNull()

        assertNotNull(error)
        assertEquals(YaConnectionPhase.REVOKED, manager.state.value.phase)
        transport.awaitCancelled()
        assertTrue(transport.cancelled)
        lease.releaseAndAwait()
        manager.shutdownAndAwait()
    }

    @Test
    fun releasingTheFinalLeaseCancelsAnOwnedRetryDelay() = runBlocking {
        val fixture = Fixture()
        fixture.connector.results.send(Result.failure(IllegalStateException("offline")))
        val manager = fixture.manager(retryDelaysMs = listOf(60_000))
        val lease = manager.acquire()
        withTimeout(2_000) {
            manager.state.first { it.phase == YaConnectionPhase.RETRYING }
        }
        val callsBeforeRelease = fixture.connector.resumeCalls

        lease.releaseAndAwait()
        delay(20)
        assertEquals(callsBeforeRelease, fixture.connector.resumeCalls)
        assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)
        manager.shutdownAndAwait()
    }

    @Test
    fun triesThePreferredDirectRouteBeforeLegacyRelayFallback() = runBlocking {
        val fixture = Fixture()
        val relayRoute = YaServerRoute.relay(
            "wss://relay.example.test/ws",
            "remote-target",
        )
        val profile = fixture.profile.copy(routes = listOf(fixture.route, relayRoute))
        val relayTransport = FakeTransport(fixture.credential)
        val opener = FakeSessionOpener(
            mapOf(
                fixture.route.websocketUrl to Result.failure(IllegalStateException("offline")),
                relayRoute.websocketUrl to Result.success(relayTransport),
            ),
        )

        val connected = YaNativeProfileConnector(opener).resume(profile, fixture.credential)

        assertEquals(relayRoute, connected.route)
        assertEquals(
            listOf(
                fixture.route.websocketUrl to null,
                relayRoute.websocketUrl to "remote-target",
            ),
            opener.attempts,
        )
    }

    @Test
    fun doesNotTurnCoroutineCancellationIntoRouteFallback() = runBlocking {
        val fixture = Fixture()
        val relayRoute = YaServerRoute.relay(
            "wss://relay.example.test/ws",
            "remote-target",
        )
        val profile = fixture.profile.copy(routes = listOf(fixture.route, relayRoute))
        val opener = FakeSessionOpener(
            mapOf(fixture.route.websocketUrl to Result.failure(CancellationException("owner left"))),
        )

        val error = runCatching {
            YaNativeProfileConnector(opener).resume(profile, fixture.credential)
        }.exceptionOrNull()

        assertTrue(error is CancellationException)
        assertEquals(listOf(fixture.route.websocketUrl to null), opener.attempts)
    }

    private class Fixture {
        val route = YaServerRoute.direct("wss://desktop.example.test/api/ws")
        val profile = YaPairedServerProfile.create(
            label = "Studio",
            username = "remote-user",
            route = route,
            nowEpochMs = NOW,
        )
        val credential = YaResumeCredential(
            username = profile.username,
            sessionId = "resume-session",
            baseKey = ByteArray(YaSecureTransportCrypto.KEY_BYTES) { it.toByte() },
            resumeProtocolVersion = YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION,
        )
        val repository = FakeRepository(
            YaPairedServerSnapshot(
                profile,
                YaStoredResumeCredential(credential, NOW, null),
            ),
        )
        val connector = FakeConnector(route)

        fun manager(
            retryDelaysMs: List<Long> = emptyList(),
            securityClients: YaSecurityClientLifecycle? = null,
        ): YaServerConnectionManager {
            return YaServerConnectionManager(
                profileId = profile.id,
                repository = repository,
                connector = connector,
                securityClients = securityClients,
                dispatcher = Dispatchers.Default,
                nowEpochMs = { NOW + 1_000 },
                retryDelaysMs = retryDelaysMs,
            )
        }
    }

    private class FakeRepository(
        private var storedSnapshot: YaPairedServerSnapshot,
    ) : YaPairedServerRepository {
        var credentialCleared = false

        override suspend fun snapshot(profileId: String): YaPairedServerSnapshot? {
            return storedSnapshot.takeIf { it.profile.id == profileId }
        }

        override suspend fun upsert(
            profile: YaPairedServerProfile,
            resumeCredential: YaStoredResumeCredential?,
            select: Boolean,
        ) {
            storedSnapshot = YaPairedServerSnapshot(profile, resumeCredential)
        }

        override suspend fun clearCredential(profileId: String) {
            credentialCleared = true
            storedSnapshot = storedSnapshot.copy(resumeCredential = null)
        }

        override suspend fun recordSuccessfulAuthentication(
            profileId: String,
            routeId: String,
            resumeCredential: YaStoredResumeCredential,
            connectedAtEpochMs: Long,
        ) {
            storedSnapshot = storedSnapshot.copy(
                profile = storedSnapshot.profile.copy(
                    preferredRouteId = routeId,
                    lastConnectedAtEpochMs = connectedAtEpochMs,
                ),
                resumeCredential = resumeCredential,
            )
        }
    }

    private class FakeConnector(
        private val route: YaServerRoute,
    ) : YaProfileConnector {
        val results = Channel<Result<YaMessageTransport>>(Channel.UNLIMITED)
        var resumeCalls = 0

        override suspend fun resume(
            profile: YaPairedServerProfile,
            credential: YaResumeCredential,
        ): YaRoutedTransport {
            resumeCalls += 1
            return YaRoutedTransport(route, results.receive().getOrThrow())
        }

        override suspend fun login(
            route: YaServerRoute,
            username: String,
            password: String,
        ): YaMessageTransport {
            error("Not used")
        }
    }

    private class FakeSessionOpener(
        private val resumeResults: Map<String, Result<YaMessageTransport>>,
    ) : YaSecureSessionOpener {
        val attempts = mutableListOf<Pair<String, String?>>()

        override suspend fun login(
            wsUrl: String,
            username: String,
            password: String,
            relayTarget: String?,
        ): YaMessageTransport {
            error("Not used")
        }

        override suspend fun resume(
            wsUrl: String,
            credential: YaResumeCredential,
            relayTarget: String?,
        ): YaMessageTransport {
            attempts += wsUrl to relayTarget
            return checkNotNull(resumeResults[wsUrl]).getOrThrow()
        }
    }

    private class FakeTransport(
        override val credential: YaResumeCredential,
    ) : YaMessageTransport {
        override val resumed = true
        val incoming = Channel<JSONObject>(Channel.UNLIMITED)
        val sent = CopyOnWriteArrayList<JSONObject>()
        var cancelled = false
        private val cancelledSignal = CompletableDeferred<Unit>()

        override fun send(message: JSONObject) {
            check(!cancelled)
            sent += JSONObject(message.toString())
        }

        override suspend fun receive(): JSONObject = incoming.receive()

        override suspend fun awaitClosed() {
            for (ignored in incoming) Unit
        }

        override suspend fun closeAndAwait() {
            cancel()
        }

        override fun cancel() {
            cancelled = true
            cancelledSignal.complete(Unit)
            incoming.close()
        }

        suspend fun awaitCancelled() {
            withTimeout(2_000) { cancelledSignal.await() }
        }

        suspend fun awaitSent(type: String): JSONObject {
            return withTimeout(2_000) {
                var message = sent.firstOrNull { it.getString("type") == type }
                while (message == null) {
                    delay(1)
                    message = sent.firstOrNull { it.getString("type") == type }
                }
                message
            }
        }
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
    }
}
