package com.yepanywhere.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.experimental.ActivityContent
import com.yepanywhere.mobile.experimental.ActivityState
import com.yepanywhere.mobile.experimental.ApiError
import com.yepanywhere.mobile.experimental.Content
import com.yepanywhere.mobile.experimental.Conversation
import com.yepanywhere.mobile.experimental.ConversationStatus
import com.yepanywhere.mobile.experimental.FailureContent
import com.yepanywhere.mobile.experimental.HistoryLimit
import com.yepanywhere.mobile.experimental.Knowledge
import com.yepanywhere.mobile.experimental.MediaContent
import com.yepanywhere.mobile.experimental.MessageRole
import com.yepanywhere.mobile.experimental.MessageState
import com.yepanywhere.mobile.experimental.QuestionRequest
import com.yepanywhere.mobile.experimental.TextContent

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YaConversationScreen(viewModel: YaConversationViewModel, onBack: () -> Unit, onOpenFull: () -> Unit) {
    val state by viewModel.presenter.state.collectAsState()
    val handoff by viewModel.handoff.collectAsState()
    val view = state.view as? Conversation
    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.conversation_title)) },
            navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.back)) } })
    }) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "header") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${viewModel.sourceName} · ${viewModel.projectName}", style = MaterialTheme.typography.labelMedium)
                    Text(viewModel.title, style = MaterialTheme.typography.headlineSmall)
                    Text(stringResource(R.string.conversation_read_only), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = onOpenFull, enabled = handoff != null) { Text(stringResource(R.string.conversation_open_full)) }
                    if (state.status == ConversationStatus.LOADING) {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        Text(stringResource(R.string.conversation_loading))
                    }
                    if (state.status != ConversationStatus.READY && state.status != ConversationStatus.LOADING) {
                        Text(stringResource(when (state.status) {
                            ConversationStatus.UPDATE_REQUIRED -> R.string.conversation_update_required
                            ConversationStatus.REVISION_MISMATCH -> R.string.conversation_revision_mismatch
                            ConversationStatus.INVALID -> R.string.conversation_invalid
                            else -> R.string.conversation_offline
                        }))
                        TextButton(onClick = viewModel.presenter::reconnect) { Text(stringResource(R.string.conversation_reconnect)) }
                    }
                    if (state.view is ApiError) Text(stringResource(R.string.conversation_unavailable))
                    else if (state.view != null && view == null) Text(stringResource(R.string.conversation_unknown))
                    if (view != null) {
                        Text(stringResource(when (view.activity) {
                            ActivityState.WORKING -> R.string.session_working
                            ActivityState.WAITING -> R.string.session_waiting
                            ActivityState.IDLE -> R.string.connection_idle
                            ActivityState.UNKNOWN -> R.string.conversation_activity_unknown
                        }), style = MaterialTheme.typography.labelMedium)
                        Text(pluralStringResource(R.plurals.conversation_message_count, view.messages.size, view.messages.size))
                    }
                    Row {
                        TextButton(onClick = viewModel.presenter::more,
                            enabled = state.status == ConversationStatus.READY && state.maxMessages < 100 &&
                                view?.coverage?.earlierInScope == true) { Text(stringResource(R.string.conversation_more)) }
                        TextButton(onClick = viewModel.presenter::latest,
                            enabled = state.status != ConversationStatus.LOADING) { Text(stringResource(R.string.conversation_latest)) }
                    }
                    if (view != null) {
                        if (view.coverage.earlierOutsideScope != Knowledge.NO || HistoryLimit.COMPACTION_SCOPE in view.coverage.limitedBy)
                            Text(stringResource(R.string.conversation_scope_limit))
                        if (HistoryLimit.BYTES in view.coverage.limitedBy || HistoryLimit.UNAVAILABLE in view.coverage.limitedBy)
                            Text(stringResource(R.string.conversation_partial))
                        if (view.coverage.anchorMessageId != null) Text(stringResource(R.string.conversation_anchored))
                        if (view.messages.isEmpty()) Text(stringResource(R.string.conversation_empty))
                    }
                }
            }
            view?.let { conversation ->
                items(conversation.messages, key = { "message:${it.id}" }) { message ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(if (message.role == MessageRole.USER) R.string.conversation_you else R.string.conversation_agent),
                                style = MaterialTheme.typography.titleSmall)
                            SelectionContainer {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    message.content.forEach { ConversationContent(it) }
                                }
                            }
                            if (message.state == MessageState.INTERRUPTED) Text(stringResource(R.string.conversation_interrupted))
                            if (message.truncated) Text(stringResource(R.string.conversation_truncated))
                        }
                    }
                }
                if (conversation.pendingRequests.isNotEmpty()) item(key = "pending") {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.conversation_pending), style = MaterialTheme.typography.titleSmall)
                            conversation.pendingRequests.forEach { request ->
                                Text(if (request is QuestionRequest) request.prompt else stringResource(R.string.conversation_unknown))
                            }
                            Text(stringResource(R.string.conversation_pending_full))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationContent(content: Content) {
    when (content) {
        is TextContent -> Text(content.text)
        is ActivityContent -> Column {
            Text(content.summary)
            Text(stringResource(R.string.conversation_tools, content.toolCount, content.failedToolCount),
                style = MaterialTheme.typography.bodySmall)
        }
        is FailureContent -> Column {
            Text(content.toolName, color = MaterialTheme.colorScheme.error)
            Text(content.message)
        }
        is MediaContent -> Text(stringResource(R.string.conversation_media, content.description))
        is Content.Unknown -> Text(stringResource(R.string.conversation_unknown))
    }
}
