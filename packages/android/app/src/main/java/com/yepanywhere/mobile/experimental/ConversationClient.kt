package com.yepanywhere.mobile.experimental

import com.yepanywhere.mobile.connection.YaApiException
import com.yepanywhere.mobile.connection.YaApiResponse
import com.yepanywhere.mobile.connection.YaConnectionLease
import com.yepanywhere.mobile.connection.YaSubscription
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.net.URLEncoder
import java.util.UUID
import org.json.JSONObject

const val CONVERSATION_API_REVISION = "simple-client-spike-1"
private const val CAPABILITY = "experimental-simple-client-conversation"

enum class ConversationAvailability { AVAILABLE, UPDATE_REQUIRED, REVISION_MISMATCH }
class ConversationUnavailableException(val reason: ConversationAvailability) : IllegalStateException()

fun conversationAvailability(version: JSONObject): ConversationAvailability {
    fun contains(field: String): Boolean {
        val entries = version.optJSONArray(field) ?: return false
        return (0 until entries.length()).any { entries.opt(it) == CAPABILITY }
    }
    fun hasBit(field: String): Boolean {
        val words = version.optJSONArray(field) ?: return false
        return (0 until words.length()).any {
            val pair = words.optJSONArray(it)
            val index = pair?.opt(0) as? Number
            val bits = pair?.opt(1) as? Number
            index?.toDouble() == 2.0 && bits != null &&
                bits.toDouble() == bits.toLong().toDouble() && bits.toLong() in 0..0xffff_ffffL &&
                bits.toLong() and 32L != 0L
        }
    }
    if (version.opt("experimentalSimpleClientApiRevision") !is String) return ConversationAvailability.UPDATE_REQUIRED
    if (!contains("capabilities") && !contains("capabilityExtensions") && !hasBit("capabilityBits") && !hasBit("optionalCapabilityBits"))
        return ConversationAvailability.UPDATE_REQUIRED
    return if (version.opt("experimentalSimpleClientApiRevision") == CONVERSATION_API_REVISION)
        ConversationAvailability.AVAILABLE else ConversationAvailability.REVISION_MISMATCH
}

class ConversationBinding(val sourceId: String, val subscriptionId: String, val sessionId: String) {
    private var sequence = -1
    private var closed = false
    init {
        require(sourceId.isNotEmpty())
        SimpleClientContract.decodeId(subscriptionId)
        SimpleClientContract.decodeId(sessionId)
    }
    fun close() { closed = true }
    fun accept(sourceId: String, encoded: String): SnapshotEnvelope? {
        if (closed || sourceId != this.sourceId) return null
        val snapshot = SimpleClientContract.decodeSnapshot(encoded)
        if (snapshot.subscriptionId != subscriptionId || snapshot.sequence <= sequence) return null
        val view = snapshot.view
        require(view !is Conversation || view.sessionId == sessionId) { "Conversation session mismatch" }
        sequence = snapshot.sequence
        return snapshot
    }
}

sealed interface ConversationReadResult {
    val sourceId: String
    data class Snapshot(override val sourceId: String, val snapshot: SnapshotEnvelope) : ConversationReadResult
    data class Unavailable(override val sourceId: String, val reason: ConversationAvailability) : ConversationReadResult
}

/** The caller's foreground lease owns authentication and connection lifetime. */
class ConversationClient(
    private val sourceId: String,
    private val request: suspend (String) -> YaApiResponse,
) {
    private var subscribe: (suspend (String, ConversationQuery) -> YaSubscription)? = null
    constructor(sourceId: String, lease: YaConnectionLease) : this(sourceId,
        { path -> lease.request("GET", path) }) {
        subscribe = { id, query -> lease.subscribeConversation(id, query) }
    }

    fun watch(query: ConversationQuery): Flow<SnapshotEnvelope> = flow {
        val version = request("/api/version").successfulBody() as? JSONObject
            ?: error("Invalid server version response")
        val availability = conversationAvailability(version)
        if (availability != ConversationAvailability.AVAILABLE) throw ConversationUnavailableException(availability)
        val binding = ConversationBinding(sourceId, UUID.randomUUID().toString(), query.sessionId)
        var subscription: YaSubscription? = null
        var initial = true
        try {
            subscription = checkNotNull(subscribe) { "Live transport is unavailable" }(binding.subscriptionId, query)
            subscription.events.collect { event ->
                if (event.eventType == "closed") error("Conversation closed")
                if (event.eventType == "snapshot") {
                    val snapshot = binding.accept(sourceId, event.data.toString())
                    if (snapshot != null) {
                        require(!initial || snapshot.sequence == 0) { "Invalid initial Conversation sequence" }
                        initial = false
                        emit(snapshot)
                    }
                }
            }
            error("Conversation ended")
        } finally {
            binding.close()
            subscription?.close()
        }
    }

    suspend fun read(query: ConversationQuery): ConversationReadResult {
        val version = request("/api/version").successfulBody() as? JSONObject
            ?: error("Invalid server version response")
        val availability = conversationAvailability(version)
        if (availability != ConversationAvailability.AVAILABLE)
            return ConversationReadResult.Unavailable(sourceId, availability)
        SimpleClientContract.decodeConversationQuery(JSONObject()
            .put("sessionId", query.sessionId).put("maxMessages", query.maxMessages)
            .put("anchorMessageId", query.anchorMessageId ?: JSONObject.NULL))
        val binding = ConversationBinding(sourceId, UUID.randomUUID().toString(), query.sessionId)
        val fields = linkedMapOf("apiRevision" to CONVERSATION_API_REVISION, "subscriptionId" to binding.subscriptionId,
            "sessionId" to query.sessionId, "maxMessages" to query.maxMessages.toString())
        query.anchorMessageId?.let { fields["anchorMessageId"] = it }
        val params = fields.entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
        val body = request("/api/experimental/conversation?$params").successfulBody()
        val snapshot = binding.accept(sourceId, body.toString()) ?: error("Invalid Conversation binding")
        require(snapshot.sequence == 0) { "Invalid initial Conversation sequence" }
        return ConversationReadResult.Snapshot(sourceId, snapshot)
    }

    private fun YaApiResponse.successfulBody(): Any? {
        if (status !in 200..299) throw YaApiException(this)
        return body
    }
}
