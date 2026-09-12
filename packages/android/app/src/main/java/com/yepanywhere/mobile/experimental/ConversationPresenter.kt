package com.yepanywhere.mobile.experimental

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class ConversationStatus { LOADING, READY, OFFLINE, UPDATE_REQUIRED, REVISION_MISMATCH, INVALID }

data class ConversationUiState(
    val status: ConversationStatus = ConversationStatus.LOADING,
    val view: SnapshotView? = null,
    val maxMessages: Int = 20,
    val anchorMessageId: String? = null,
)

/** One selected source/session; visibility owns live demand, never a poll loop. */
class ConversationPresenter(
    private val sessionId: String,
    private val scope: CoroutineScope,
    private val watch: (ConversationQuery) -> Flow<SnapshotEnvelope>,
) {
    private val mutableState = MutableStateFlow(ConversationUiState())
    val state = mutableState.asStateFlow()
    private var visible = false
    private var job: Job? = null
    private var revision = 0L

    fun setVisible(value: Boolean) {
        if (visible == value) return
        visible = value
        restart()
    }

    fun reconnect() = restart()

    fun more() {
        val current = state.value
        val view = current.view as? Conversation ?: return
        if (current.status != ConversationStatus.READY || current.maxMessages >= 100 || !view.coverage.earlierInScope) return
        mutableState.value = current.copy(maxMessages = minOf(100, current.maxMessages + 20),
            anchorMessageId = view.messages.lastOrNull()?.id)
        restart()
    }

    fun latest() {
        mutableState.value = state.value.copy(anchorMessageId = null)
        restart()
    }

    private fun restart() {
        val generation = ++revision
        job?.cancel()
        job = null
        if (!visible) return
        val current = state.value
        mutableState.value = current.copy(status = ConversationStatus.LOADING)
        job = scope.launch {
            try {
                watch(ConversationQuery(sessionId, current.maxMessages, current.anchorMessageId)).collect { snapshot ->
                    if (generation == revision) mutableState.value = state.value.copy(
                        status = ConversationStatus.READY, view = snapshot.view)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (generation == revision) mutableState.value = state.value.copy(status = when (error) {
                    is ConversationUnavailableException -> if (error.reason == ConversationAvailability.REVISION_MISMATCH)
                        ConversationStatus.REVISION_MISMATCH else ConversationStatus.UPDATE_REQUIRED
                    is IllegalArgumentException -> ConversationStatus.INVALID
                    else -> ConversationStatus.OFFLINE
                })
            }
        }
    }
}
