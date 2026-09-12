package com.yepanywhere.mobile.experimental

import com.yepanywhere.mobile.connection.YaApiResponse
import java.net.URLDecoder
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConversationClientTest {
    @Test fun missingAndDifferentRevisionsHaveDistinctFallbacks() {
        assertEquals(ConversationAvailability.UPDATE_REQUIRED, conversationAvailability(supported().put("experimentalSimpleClientApiRevision", JSONObject.NULL)))
        assertEquals(ConversationAvailability.REVISION_MISMATCH, conversationAvailability(supported().put("experimentalSimpleClientApiRevision", "future")))
    }

    private fun supported() = JSONObject("""{"capabilityBits":[[2,32]],"experimentalSimpleClientApiRevision":"simple-client-spike-1"}""")
    private fun frame(id: String, sequence: Int = 0) = JSONObject()
        .put("apiRevision", CONVERSATION_API_REVISION).put("subscriptionId", id).put("sequence", sequence)
        .put("view", JSONObject("""{"kind":"error","code":"unavailable","message":"Test source"}""")).toString()

    @Test fun missingCapabilityAndRevisionMismatchMakeZeroExperimentalCalls() = runBlocking {
        for (version in listOf(JSONObject("""{"current":"0.8.0"}"""), JSONObject("""{"current":"0.8.1"}"""), supported().put("experimentalSimpleClientApiRevision", JSONObject.NULL), supported().put("experimentalSimpleClientApiRevision", "future"))) {
            val paths = mutableListOf<String>()
            val client = ConversationClient("old") { path -> paths.add(path); YaApiResponse(200, emptyMap(), version) }
            assertTrue(client.read(ConversationQuery("s", 20, null)) is ConversationReadResult.Unavailable)
            assertEquals(listOf("/api/version"), paths)
        }
    }

    @Test fun healthyPeerConsumesTheTypedSnapshot() = runBlocking {
        val paths = mutableListOf<String>()
        val client = ConversationClient("peer") { path ->
            paths.add(path)
            val body = if (path == "/api/version") supported() else {
                val id = path.substringAfter("?").split("&").first { it.startsWith("subscriptionId=") }.substringAfter("=")
                JSONObject(frame(URLDecoder.decode(id, "UTF-8")))
            }
            YaApiResponse(200, emptyMap(), body)
        }
        val result = client.read(ConversationQuery("s", 20, null)) as ConversationReadResult.Snapshot
        assertEquals("peer", result.sourceId)
        assertEquals(0, result.snapshot.sequence)
        assertEquals(2, paths.size)
    }

    @Test fun bindingRejectsCrossSourceStaleDuplicateAndClosedFrames() {
        val binding = ConversationBinding("a", "new", "s")
        assertNull(binding.accept("b", frame("new")))
        assertNull(binding.accept("a", frame("old")))
        assertNotNull(binding.accept("a", frame("new")))
        assertNull(binding.accept("a", frame("new")))
        assertNotNull(binding.accept("a", frame("new", 2)))
        assertNull(binding.accept("a", frame("new", 1)))
        binding.close()
        assertNull(binding.accept("a", frame("new", 3)))
    }
}
