package com.yepanywhere.mobile.experimental

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class ConversationPresenterTest {
    private class Watch(val query: ConversationQuery) {
        val frames = Channel<SnapshotEnvelope>(Channel.UNLIMITED)
        val closed = Channel<Unit>(1)
    }

    @Test fun visibilityHistoryAndReconnectOwnFreshWatches() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val watches = Channel<Watch>(Channel.UNLIMITED)
        val presenter = ConversationPresenter("session", scope) { query -> flow {
            val watch = Watch(query)
            watches.send(watch)
            try { for (frame in watch.frames) emit(frame) } finally { watch.closed.send(Unit) }
        } }
        try {
            presenter.setVisible(true)
            val first = withTimeout(1000) { watches.receive() }
            assertEquals(ConversationQuery("session", 20, null), first.query)
            first.frames.send(snapshot("last-20"))
            withTimeout(1000) { presenter.state.first { it.status == ConversationStatus.READY } }
            presenter.more()
            val more = withTimeout(1000) { watches.receive() }
            withTimeout(1000) { first.closed.receive() }
            assertEquals(ConversationQuery("session", 40, "last-20"), more.query)
            more.frames.send(snapshot("last-20"))
            withTimeout(1000) { presenter.state.first { it.status == ConversationStatus.READY } }
            presenter.latest()
            val latest = withTimeout(1000) { watches.receive() }
            assertEquals(ConversationQuery("session", 40, null), latest.query)
            withTimeout(1000) { more.closed.receive() }
            latest.frames.close(IllegalStateException("Network lost"))
            withTimeout(1000) { presenter.state.first { it.status == ConversationStatus.OFFLINE } }
            assertNotNull(presenter.state.value.view)
            presenter.reconnect()
            val reconnect = withTimeout(1000) { watches.receive() }
            presenter.setVisible(false)
            withTimeout(1000) { reconnect.closed.receive() }
            presenter.reconnect()
            assertTrue(watches.tryReceive().isFailure)
            presenter.setVisible(true)
            val foreground = withTimeout(1000) { watches.receive() }
            assertEquals(latest.query, foreground.query)
            presenter.setVisible(false)
            withTimeout(1000) { foreground.closed.receive() }
        } finally { scope.cancel() }
    }

    @Test fun compatibilityAndMalformedDataHaveDistinctStates() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            for ((error, expected) in listOf(
                ConversationUnavailableException(ConversationAvailability.UPDATE_REQUIRED) to ConversationStatus.UPDATE_REQUIRED,
                ConversationUnavailableException(ConversationAvailability.REVISION_MISMATCH) to ConversationStatus.REVISION_MISMATCH,
                IllegalArgumentException("Malformed") to ConversationStatus.INVALID,
            )) {
                val presenter = ConversationPresenter("s", scope) { flow { throw error } }
                presenter.setVisible(true)
                assertEquals(expected, withTimeout(1000) { presenter.state.first { it.status != ConversationStatus.LOADING } }.status)
                assertNull(presenter.state.value.view)
                presenter.setVisible(false)
            }
        } finally { scope.cancel() }
    }

    private fun snapshot(lastId: String) = SnapshotEnvelope(CONVERSATION_API_REVISION, "binding", 0,
        Conversation("conversation", "session", ActivityState.IDLE,
            listOf(ConversationMessage(lastId, MessageRole.AGENT, null, MessageState.COMPLETE, false,
                listOf(TextContent("text", TextFormat.PLAIN, "Visible response")))), emptyList(),
            HistoryCoverage("twoCompactions", 0, 20, 1, true, Knowledge.NO, true,
                listOf(HistoryLimit.MAX_MESSAGES), null)))
}
