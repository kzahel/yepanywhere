package com.yepanywhere.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.profiles.YaServerRemovalCoordinator
import com.yepanywhere.mobile.profiles.YaServerRemovalOutcome
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.yepanywhere.mobile.notifications.NotificationFoundation
import com.yepanywhere.mobile.notifications.NotificationStatusReader

/** Observes saved hosts and connection status without acquiring dashboard leases. */
class YaHostManagementViewModel(application: Application) : AndroidViewModel(application) {
    private val runtime = (application as YepAnywhereApplication).nativeRuntime
    private val store = runtime.pairedServers
    private val mutableState = MutableStateFlow(YaHostManagementState())
    private val mutableOpenProfile = MutableSharedFlow<YaOpenProfile>(extraBufferCapacity = 1)
    private val observers = mutableMapOf<String, Job>()
    private val removal = YaServerRemovalCoordinator(store::forget)
    val state = mutableState.asStateFlow()
    internal val openProfile = mutableOpenProfile.asSharedFlow()

    init {
        refreshNotifications()
        viewModelScope.launch {
            store.listState.collect { list ->
                val snapshots = store.snapshots().associateBy { it.profile.id }
                // Reading push status can suspend across pairing completion.
                // Read the UI state only after the server lookups finish.
                val servers = list.profiles.mapNotNull { profile ->
                    val snapshot = snapshots[profile.id] ?: return@mapNotNull null
                    val pushEnabled = runtime.nativePush.enabled(profile.id)
                    profile.id to YaHostState(snapshot.profile,
                        savedHostConnection(snapshot, runtime.connectionManager(profile.id).state.value, System.currentTimeMillis()),
                        pushEnabled)
                }.toMap()
                mutableState.value = mutableState.value.copy(profiles = list.profiles, servers = servers)
                observers.keys.filter { id -> list.profiles.none { it.id == id } }.forEach { observers.remove(it)?.cancel() }
                list.profiles.forEach { profile ->
                    if (profile.id !in observers) observers[profile.id] = launch {
                        runtime.connectionManager(profile.id).state.collect connectionState@ {
                            val snapshot = store.snapshot(profile.id) ?: return@connectionState
                            val source = mutableState.value.servers[profile.id] ?: return@connectionState
                            mutableState.value = mutableState.value.copy(
                                servers = mutableState.value.servers + (profile.id to source.copy(
                                    profile = snapshot.profile,
                                    connection = savedHostConnection(snapshot, runtime.connectionManager(profile.id).state.value, System.currentTimeMillis()),
                                )),
                            )
                        }
                    }
                }
            }
        }
    }

    fun select(profileId: String, newTab: Boolean = false) = action {
        val snapshot = checkNotNull(store.snapshot(profileId))
        if (snapshot.profile.securityClient?.revoked == true) error("Pair the revoked device again")
        store.select(profileId)
        mutableOpenProfile.emit(YaOpenProfile(profileId, newTab))
    }

    fun pair(input: YaPairingInput) = action {
        val username = input.normalizedUsername()
        if (username.isBlank() || input.password.isEmpty()) {
            mutableState.value = mutableState.value.copy(error = YaNativeUiError.INVALID_SERVER_DETAILS)
            return@action
        }
        val route = try { input.resolveRoute(username) } catch (_: IllegalArgumentException) {
            mutableState.value = mutableState.value.copy(error = YaNativeUiError.INVALID_SERVER_DETAILS)
            return@action
        }
        val profile = runtime.pairing.pair(username, username, input.password, route)
        // Offer notifications once, while the user is still here and Android can show them.
        if (mutableState.value.deviceNotifications in setOf(YaDeviceNotifications.READY, YaDeviceNotifications.CAN_ASK)) {
            mutableState.value = mutableState.value.copy(pushOffer = profile.id, pushOfferAccepted = false)
        } else mutableOpenProfile.emit(YaOpenProfile(profile.id))
    }

    /** Returns the offered profile so the activity can run the permission and enable flow. */
    fun acceptPushOffer(): String? {
        val profileId = mutableState.value.pushOffer ?: return null
        mutableState.value = mutableState.value.copy(pushOfferAccepted = true)
        return profileId
    }

    /** Ends the offer; the new server opens unless enabling failed and its error must stay visible. */
    fun finishPushOffer(open: Boolean = true) {
        val profileId = mutableState.value.pushOffer ?: return
        mutableState.value = mutableState.value.copy(pushOffer = null, pushOfferAccepted = false)
        if (open) viewModelScope.launch { mutableOpenProfile.emit(YaOpenProfile(profileId)) }
    }

    fun reauthenticate(profileId: String, password: String, newTab: Boolean = false) = action {
        runtime.pairing.reauthenticate(profileId, password)
        store.select(profileId)
        mutableOpenProfile.emit(YaOpenProfile(profileId, newTab))
    }

    fun removeProfile(profileId: String) = action {
        val profile = store.snapshot(profileId)?.profile ?: return@action
        val result = removal.remove(profile) { clientId ->
            val lease = runtime.connectionManager(profileId).acquire()
            try { lease.request("DELETE", "/security/clients/$clientId") }
            finally { lease.releaseAndAwait() }
        }
        showRemovalResult(profileId, result)
    }
    fun forgetAnyway(profileId: String) = action { showRemovalResult(profileId, removal.forgetAnyway(profileId)) }
    fun clearRemovalPrompt() { mutableState.value = mutableState.value.copy(removalPrompt = null) }
    fun clearError() { mutableState.value = mutableState.value.copy(error = null) }

    /**
     * Android permission and channel settings change outside the app; re-read
     * them on resume. [enableWhenReady] finishes an enable the user started
     * before Android asked for, or sent them to Settings for, permission.
     */
    fun refreshNotifications(enableWhenReady: String? = null) {
        viewModelScope.launch {
            val app = getApplication<Application>()
            val status = withContext(Dispatchers.IO) {
                NotificationStatusReader(app, NotificationFoundation.installationStore(app)).read()
            }
            val device = deviceNotifications(status)
            mutableState.value = mutableState.value.copy(deviceNotifications = device)
            if (enableWhenReady != null && device == YaDeviceNotifications.READY) setPush(enableWhenReady, true)
            else if (enableWhenReady != null) finishPushOffer()
        }
    }
    fun setPush(profileId: String, enabled: Boolean) = pushAction(profileId) {
        if (enabled) runtime.nativePush.enable(profileId) else runtime.nativePush.disable(profileId)
    }
    fun testPush(profileId: String) = pushAction(profileId) { runtime.nativePush.test(profileId) }
    private fun pushAction(profileId: String, operation: suspend () -> Unit) {
        if (mutableState.value.actionInProgress) return
        mutableState.value = mutableState.value.copy(actionInProgress = true, error = null)
        viewModelScope.launch {
            var failed = false
            try { operation() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { failed = true; mutableState.value = mutableState.value.copy(error = nativePushActionError(error)) }
            finally {
                val enabled = runtime.nativePush.enabled(profileId)
                val state = mutableState.value
                val source = state.servers[profileId]
                val servers = if (source == null) state.servers else state.servers + (profileId to source.copy(pushEnabled = enabled))
                mutableState.value = state.copy(actionInProgress = false, servers = servers)
                if (mutableState.value.pushOffer == profileId) finishPushOffer(open = !failed)
            }
        }
    }

    private fun showRemovalResult(profileId: String, result: YaServerRemovalOutcome) {
        mutableState.value = mutableState.value.copy(removalPrompt = when (result) {
            YaServerRemovalOutcome.COMPLETE -> null
            YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY -> YaRemovalPrompt(profileId, YaRemovalPromptKind.SERVER_RECORD_MAY_REMAIN)
            YaServerRemovalOutcome.NEEDS_LOCAL_CLEANUP -> YaRemovalPrompt(profileId, YaRemovalPromptKind.SERVER_ALREADY_UNREGISTERED)
        })
    }

    private fun action(block: suspend () -> Unit) {
        if (mutableState.value.actionInProgress) return
        mutableState.value = mutableState.value.copy(actionInProgress = true, error = null)
        viewModelScope.launch {
            try { block() }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { mutableState.value = mutableState.value.copy(error = nativeHostActionError(error)) }
            finally { mutableState.value = mutableState.value.copy(actionInProgress = false) }
        }
    }
}
