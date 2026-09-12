package com.yepanywhere.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.experimental.ConversationClient
import com.yepanywhere.mobile.experimental.ConversationPresenter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.yepanywhere.mobile.web.ConversationHandoff
import com.yepanywhere.mobile.web.WebClientConfig
import com.yepanywhere.mobile.web.conversationHandoff

class YaConversationViewModel(application: Application, saved: SavedStateHandle) : AndroidViewModel(application) {
    private val runtime = (application as YepAnywhereApplication).nativeRuntime
    val profileId: String = checkNotNull(saved["profileId"])
    val sessionId: String = checkNotNull(saved["sessionId"])
    val projectId: String = checkNotNull(saved["projectId"])
    val title: String = saved["title"] ?: sessionId
    val projectName: String = saved["projectName"] ?: ""
    val sourceName: String = saved["sourceName"] ?: ""
    private val mutableHandoff = MutableStateFlow<ConversationHandoff?>(null)
    val handoff = mutableHandoff.asStateFlow()
    init {
        viewModelScope.launch {
            runtime.pairedServers.listState.collect { list ->
                mutableHandoff.value = list.profiles.firstOrNull { it.id == profileId }?.let {
                    conversationHandoff(it, projectId, sessionId, WebClientConfig.fromBuild().startUrl)
                }
            }
        }
    }
    val presenter = ConversationPresenter(sessionId, viewModelScope) { query ->
        flow {
            val lease = runtime.connectionManager(profileId).acquire()
            try {
                emitAll(ConversationClient(profileId, lease).watch(query))
            } finally {
                withContext(NonCancellable) { lease.releaseAndAwait() }
            }
        }.flowOn(Dispatchers.Default)
    }
}
