package com.yepanywhere.mobile.experimental

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SimpleClientContractTest {
    private fun read(name: String): String = requireNotNull(javaClass.classLoader?.getResourceAsStream("simple-client/$name")) {
        "Missing shared fixture $name"
    }.bufferedReader().use { it.readText() }

    private fun rejects(block: () -> Unit) {
        val outcome = runCatching(block)
        assertTrue("Expected decoder rejection", outcome.isFailure)
    }

    @Test fun sharedExamplesDecodeIntoTypedModels() {
        val examples = JSONArray(read("examples.json"))
        for (i in 0 until examples.length()) {
            val example = examples.getJSONObject(i)
            val snapshot = SimpleClientContract.decodeSnapshot(read(example.getString("file")))
            when (val view = snapshot.view) {
                is Conversation -> {
                    assertEquals("conversation", example.getString("kind"))
                    assertEquals(example.getInt("messageCount"), view.messages.size)
                    assertEquals(view.messages.size, view.coverage.returnedMessages)
                    assertTrue(view.messages.size <= view.coverage.maxMessages)
                    assertEquals(view.messages.size, view.messages.map { it.id }.toSet().size)
                }
                is SourceOverview -> assertEquals("overview", example.getString("kind"))
                is SnapshotView.Unknown -> assertEquals("unknown", example.getString("kind"))
                is ApiError -> fail("Unexpected error fixture")
            }
        }
    }

    @Test fun sharedInvalidPayloadsReject() {
        val cases = JSONArray(read("invalid-snapshots.json"))
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val outcome = runCatching { SimpleClientContract.decodeSnapshot(case.getJSONObject("payload").toString()) }
            assertTrue(case.getString("name"), outcome.isFailure)
        }
    }

    @Test fun unknownContentAndPendingRequestsStayOpaque() {
        val view = SimpleClientContract.decodeSnapshot(read("waiting-history.json")).view as Conversation
        val content = view.messages[0].content[1] as Content.Unknown
        assertEquals("future-diagram", content.originalKind)
        assertEquals(2, content.raw.getInt("version"))
        assertEquals("one", content.raw.getJSONObject("payload").getJSONArray("nodes").getString(0))
        val request = view.pendingRequests[1] as PendingRequest.Unknown
        assertEquals("future-approval", request.originalKind)
        assertTrue(request.raw.getBoolean("canApprove"))
        assertFalse((view.pendingRequests[0] as QuestionRequest).canAnswer)
        val unknownView = SimpleClientContract.decodeSnapshot(read("unknown-view.json")).view as SnapshotView.Unknown
        assertEquals("future-view", unknownView.originalKind)
        assertTrue(unknownView.raw.getJSONArray("payload").getJSONObject(0).isNull("key"))
    }

    @Test fun disabledIssuesAndSourceCollisionsRemainExplicit() {
        val a = SimpleClientContract.decodeSnapshot(read("overview-disabled.json")).view as SourceOverview
        val b = SimpleClientContract.decodeSnapshot(read("overview-peer.json")).view as SourceOverview
        assertEquals(IssueCoverage.DISABLED, a.sessions[0].issueCoverage)
        assertTrue(a.sessions[0].issues.isEmpty())
        assertEquals(a.sessions[0].id, b.sessions[0].id)
        val examples = JSONArray(read("examples.json"))
        val sources = (0 until examples.length()).map { examples.getJSONObject(it) }.associate { it.getString("file") to it.getString("sourceKey") }
        assertNotEquals(sources["overview-disabled.json"] to a.sessions[0].id, sources["overview-peer.json"] to b.sessions[0].id)
        assertEquals(b.sessions[0].issues[0].key, b.sessions[0].issues[1].key)
        assertNotEquals(b.sessions[0].issues[0].id, b.sessions[0].issues[1].id)
    }

    @Test fun completeTailCountsGroupedMessages() {
        val full = SimpleClientContract.decodeSnapshot(read("claude-conversation.json")).view as Conversation
        val tail = SimpleClientContract.decodeSnapshot(read("claude-tail.json")).view as Conversation
        assertEquals(full.messages.takeLast(2), tail.messages)
        assertEquals(2, tail.coverage.compactions)
        assertEquals(2, tail.coverage.maxMessages)
        assertTrue(tail.coverage.earlierInScope)
        assertTrue(tail.coverage.completeForRequest)
        assertEquals(listOf(HistoryLimit.MAX_MESSAGES), tail.coverage.limitedBy)
        val activity = full.messages[1].content.filterIsInstance<ActivityContent>().single()
        assertEquals(4, activity.toolCount)
        assertEquals(1, activity.failedToolCount)
    }

    @Test fun additiveFieldsAreIgnoredAndUnknownRawDataIsCopied() {
        val known = SimpleClientContract.decodeContent(JSONObject().put("kind", "text").put("format", "plain").put("text", "hello").put("future", true)) as TextContent
        assertEquals("hello", known.text)
        val raw = JSONObject().put("kind", "future").put("payload", JSONObject().put("value", 1))
        val unknown = SimpleClientContract.decodeContent(raw) as Content.Unknown
        raw.getJSONObject("payload").put("value", 2)
        assertEquals(1, unknown.raw.getJSONObject("payload").getInt("value"))
        assertEquals("__proto__", (SimpleClientContract.decodeContent(JSONObject().put("kind", "__proto__")) as Content.Unknown).originalKind)
    }

    @Test fun unicodeLimitsCountCodePoints() {
        fun text(length: Int) = JSONObject().put("kind", "text").put("format", "plain").put("text", "👋".repeat(length))
        assertTrue(SimpleClientContract.decodeContent(text(16000)) is TextContent)
        rejects { SimpleClientContract.decodeContent(text(16001)) }
        assertTrue(SimpleClientContract.decodeContent(JSONObject().put("kind", "👋".repeat(128))) is Content.Unknown)
        rejects { SimpleClientContract.decodeContent(JSONObject().put("kind", "👋".repeat(129))) }
    }

    @Test fun byteLimitAppliesToUnknownVariantsToo() {
        val base = JSONObject(read("unknown-view.json"))
        base.getJSONObject("view").put("payload", "")
        val padding = SimpleClientContract.MAX_SNAPSHOT_BYTES - base.toString().toByteArray(Charsets.UTF_8).size
        base.getJSONObject("view").put("payload", "x".repeat(padding))
        assertTrue(SimpleClientContract.decodeSnapshot(base.toString()).view is SnapshotView.Unknown)
        base.getJSONObject("view").put("payload", "x".repeat(padding) + "👋")
        rejects { SimpleClientContract.decodeSnapshot(base.toString()) }
    }

    @Test fun historyQueryRequiresBoundedCountAndExplicitNullableAnchor() {
        fun query(count: Double) = JSONObject().put("sessionId", "s").put("maxMessages", count).put("anchorMessageId", JSONObject.NULL)
        assertEquals(20, SimpleClientContract.decodeConversationQuery(query(20.0)).maxMessages)
        for (count in listOf(0.0, 101.0, 1.5)) rejects { SimpleClientContract.decodeConversationQuery(query(count)) }
        rejects { SimpleClientContract.decodeConversationQuery(query(20.0).also { it.remove("anchorMessageId") }) }
    }
}
