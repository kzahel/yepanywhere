package com.yepanywhere.mobile.web

import com.yepanywhere.mobile.connection.YaApiException
import com.yepanywhere.mobile.connection.YaConnectionLease
import com.yepanywhere.mobile.connection.YaSubscription
import com.yepanywhere.mobile.connection.YaSubscriptionOverflowException
import com.yepanywhere.mobile.connection.YaConnectionUnavailableException
import com.yepanywhere.mobile.connection.YaNativeOperationException
import com.yepanywhere.mobile.connection.YaNativeOperationFailure
import com.yepanywhere.mobile.connection.YaResponseBody
import java.io.Closeable
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import org.json.JSONObject

/** A document's source capability, not a credential or a raw relay proxy. */
class YaWebTransportSession(
    val handle: String,
    private val lease: YaConnectionLease,
    private val scope: CoroutineScope,
    private val emit: suspend (JSONObject) -> Unit,
    private val recordCancellation: () -> Unit = {},
    private val emitBytes: suspend (ByteArray) -> Unit = {},
    private val switchHost: () -> Unit,
) : Closeable {
    private val operations = ConcurrentHashMap<String, Job>()
    private val subscriptions = ConcurrentHashMap<String, YaSubscription>()
    private val subscriptionJobs = ConcurrentHashMap<String, Job>()
    private val uploadIds = ConcurrentHashMap<String, String>()
    private val responses = ConcurrentHashMap<String, YaResponseBody>()
    @Volatile private var closed = false
    private val ownership = Any()

    fun dispatch(command: JSONObject) {
        check(!closed && command.getString("handle") == handle) { "Stale native source handle" }
        val id = command.getString("id")
        require(id.length in 1..128)
        val method = command.getString("method")
        val params = command.optJSONObject("params") ?: JSONObject()
        if (method == "cancel") {
            synchronized(ownership) {
                val target = params.getString("id")
                operations[target]?.let { recordCancellation(); it.cancel() }
                responses.remove(target)?.close()
            }
            return
        }
        require(operations.size < 32 && !operations.containsKey(id)) { "Native operation limit exceeded" }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val result = when (method) {
                    "request" -> request(params)
                    "responseStart" -> startResponse(params, id)
                    "responseRead" -> {
                        val responseId = params.getString("responseId")
                        val response = checkNotNull(responses[responseId]) { "Native response closed" }
                        try {
                            val chunk = response.nextChunk()
                            if (chunk != null) {
                                val requestId = UUID.fromString(id)
                                emitBytes(ByteBuffer.allocate(16 + chunk.size).putLong(requestId.mostSignificantBits)
                                    .putLong(requestId.leastSignificantBits).put(chunk).array())
                                return@launch
                            }
                            responses.remove(responseId, response)
                            response.close()
                            JSONObject().put("done", true)
                        } catch (error: Throwable) { responses.remove(responseId, response); response.close(); throw error }
                    }
                    "subscribe" -> subscribe(params)
                    "unsubscribe" -> {
                        val localId = params.getString("subscriptionId")
                        synchronized(ownership) {
                            subscriptions.remove(localId)?.close()
                            subscriptionJobs.remove(localId)?.cancel()
                        }
                        JSONObject()
                    }
                    "uploadStart" -> startUpload(params)
                    "uploadEnd" -> {
                        lease.endUpload(checkNotNull(uploadIds[params.getString("uploadId")]))
                        JSONObject()
                    }
                    "uploadCancel" -> {
                        uploadIds.remove(params.getString("uploadId"))?.let { lease.cancelUpload(it) }
                        JSONObject()
                    }
                    "status" -> lease.state().let { JSONObject().put("phase", it.phase.name)
                        .put("recoverable", it.recoverable).put("retryAttempt", it.retryAttempt).put("connectionEpoch", it.connectionEpoch) }
                    "reconnect" -> { lease.reconnect(params.optBoolean("retry", true)); JSONObject() }
                    "switchHost" -> { switchHost(); JSONObject() }
                    else -> error("Unsupported native source operation")
                }
                emit(JSONObject().put("type", "reply").put("id", id).put("result", result))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val code = nativeErrorCode(error)
                emit(JSONObject().put("type", "reply").put("id", id)
                    .put("errorCode", code)
                    .put("error", error.message ?: "Native source operation failed"))
            }
        }
        check(operations.putIfAbsent(id, job) == null)
        if (method == "subscribe") {
            val localId = params.getString("subscriptionId")
            synchronized(ownership) {
                require(localId.length in 1..128 && subscriptionJobs.size < 64)
                require(subscriptionJobs.putIfAbsent(localId, job) == null)
            }
        }
        job.invokeOnCompletion {
            operations.remove(id, job)
            if (method == "subscribe" && !subscriptions.containsKey(params.getString("subscriptionId"))) {
                subscriptionJobs.remove(params.getString("subscriptionId"), job)
            }
        }
        job.start()
    }

    suspend fun uploadChunk(payload: ByteArray) {
        require(payload.size in 25..(24 + 65536))
        val bytes = ByteBuffer.wrap(payload)
        val localId = UUID(bytes.long, bytes.long).toString()
        val offset = bytes.long
        val chunk = ByteArray(bytes.remaining()).also(bytes::get)
        try {
            check(!closed) { "Native page is suspended" }
            lease.sendUploadChunk(checkNotNull(uploadIds[localId]) { "Upload is no longer active" }, offset, chunk)
        } catch (error: CancellationException) { throw error
        } catch (error: Throwable) {
            // A queued chunk can arrive after network loss has retired its upload.
            // Fail that operation, not the document's local transport bridge.
            emit(JSONObject().put("type", "upload_error").put("uploadId", localId)
                .put("error", error.message ?: "Native upload failed"))
        }
    }

    private fun nativeErrorCode(error: Throwable): String? = when (error) {
        is YaNativeOperationException -> error.failure.name
        is YaConnectionUnavailableException -> YaNativeOperationFailure.CONNECTION_UNAVAILABLE.name
        is YaSubscriptionOverflowException -> YaNativeOperationFailure.OVERFLOW.name
        else -> null
    }

    private suspend fun request(params: JSONObject): JSONObject {
        val supplied = params.optJSONObject("headers") ?: JSONObject()
        val headers = supplied.keys().asSequence().associateWith(supplied::getString)
        val response = try {
            lease.request(params.getString("method"), params.getString("path"),
                if (params.isNull("body")) null else params.opt("body"), headers)
        } catch (error: YaApiException) { error.response }
        return JSONObject().put("status", response.status).put("headers", JSONObject(response.headers))
            .put("body", response.body ?: JSONObject.NULL)
    }

    private suspend fun startResponse(params: JSONObject, id: String): JSONObject {
        val supplied = params.optJSONObject("headers") ?: JSONObject()
        val headers = supplied.keys().asSequence().associateWith(supplied::getString)
        val response = lease.fetchResponse(params.getString("path"), headers)
        val metadata = response.metadata
        if (!metadata.optBoolean("streaming")) { response.close(); return metadata }
        val operation = currentCoroutineContext()[Job]
        synchronized(ownership) {
            if (closed || operation?.isActive != true || responses.size >= 8) { response.close(); error("Native response owner unavailable") }
            responses[id] = response
        }
        return JSONObject(metadata.toString()).put("responseId", id)
    }

    private suspend fun subscribe(params: JSONObject): JSONObject {
        val localId = params.getString("subscriptionId")
        require(localId.length in 1..128 && subscriptions.size < 64 && !subscriptions.containsKey(localId))
        val subscription = lease.subscribe(
            channel = params.getString("channel"),
            sessionId = params.optNullableString("sessionId"),
            projectId = params.optNullableString("projectId"),
            provider = params.optNullableString("provider"),
            lastEventId = params.optNullableString("lastEventId"),
            wantsLiveDeltas = if (params.has("wantsLiveDeltas")) params.getBoolean("wantsLiveDeltas") else null,
            coverage = params.optJSONObject("coverage"),
        )
        val reservation = currentCoroutineContext()[Job]
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                subscription.events.collect { event ->
                    emit(JSONObject().put("type", "event").put("subscriptionId", localId)
                        .put("eventType", event.eventType).put("eventId", event.eventId ?: JSONObject.NULL)
                        .put("data", event.data ?: JSONObject.NULL))
                }
            } catch (error: CancellationException) { throw error
            } catch (error: Throwable) {
                emit(JSONObject().put("type", "subscriptionError").put("subscriptionId", localId)
                    .put("status", (error as? YaApiException)?.response?.status)
                    .put("errorCode", nativeErrorCode(error))
                    .put("error", error.message ?: "Native subscription failed"))
            } finally {
                val completingJob = currentCoroutineContext()[Job]
                synchronized(ownership) {
                    subscriptions.remove(localId, subscription)
                    subscriptionJobs.remove(localId, completingJob)
                }
                subscription.close()
            }
        }
        synchronized(ownership) {
            if (closed || subscriptionJobs[localId] !== reservation) {
                subscription.close()
                job.cancel()
                throw CancellationException("Native subscription is no longer owned")
            }
            subscriptions[localId] = subscription
            subscriptionJobs[localId] = job
        }
        job.start()
        return JSONObject()
    }

    private suspend fun startUpload(params: JSONObject): JSONObject {
        val localId = params.getString("uploadId")
        require(UUID.fromString(localId).toString() == localId && !uploadIds.containsKey(localId))
        val upload = lease.startUpload(params)
        val owned = synchronized(ownership) {
            if (closed) false else { uploadIds[localId] = upload.id; true }
        }
        if (!owned) { lease.cancelUpload(upload.id); error("Native document closed") }
        scope.launch {
            try {
                upload.events.collect { event -> emit(JSONObject(event.toString()).put("uploadId", localId)) }
            } catch (error: CancellationException) { throw error
            } catch (error: Throwable) {
                emit(JSONObject().put("type", "upload_error").put("uploadId", localId)
                    .put("error", error.message ?: "Native upload failed"))
            } finally { uploadIds.remove(localId) }
        }
        return JSONObject()
    }

    override fun close() {
        synchronized(ownership) {
        closed = true
        operations.values.forEach(Job::cancel)
        subscriptionJobs.values.forEach(Job::cancel)
        subscriptions.values.forEach(YaSubscription::close)
        operations.clear()
        subscriptions.clear()
        subscriptionJobs.clear()
        uploadIds.clear()
        responses.values.forEach(YaResponseBody::close)
        responses.clear()
        }
        lease.close()
    }
}

private fun JSONObject.optNullableString(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)
