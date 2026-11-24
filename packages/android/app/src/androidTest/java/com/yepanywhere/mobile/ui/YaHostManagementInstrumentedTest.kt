package com.yepanywhere.mobile.ui

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaServerRoute
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class YaHostManagementInstrumentedTest {
    @get:org.junit.Rule
    val launcherAnrRecovery = com.yepanywhere.mobile.LauncherAnrRecoveryRule()

    @Test
    fun freshRelayPairingOpensAfterRegistration() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val relay = arguments.getString("yaProbeRelayWsUrl")
        val username = arguments.getString("yaProbeUsername")
        val password = arguments.getString("yaProbePassword")
        assumeTrue("Disposable relay pairing arguments absent", relay != null && username != null && password != null)
        val app = instrumentation.targetContext.applicationContext as YepAnywhereApplication
        val store = app.nativeRuntime.pairedServers
        val previousSelection = runBlocking { store.selectedProfileId.first() }
        val previousProfiles = runBlocking { store.snapshots().map { it.profile.id }.toSet() }
        val tabs = app.getSharedPreferences("native-tabs", android.content.Context.MODE_PRIVATE)
        val previousTabs = tabs.getString("state", null)
        val device = UiDevice.getInstance(instrumentation)
        val scenario = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra(MainActivity.SHOW_HOSTS, true))
        val project = By.text("preview-project")
        val decline = app.getString(R.string.native_push_offer_decline)
        fun button(label: Int): UiObject2 = checkNotNull(device.wait(Until.findObject(By.text(app.getString(label))), 5_000)) {
            "The native pairing screen did not show ${app.getString(label)}"
        }
        try {
            if (previousProfiles.isNotEmpty()) button(R.string.add_server).click()
            val editor = By.clazz("android.widget.EditText")
            assertTrue(device.wait(Until.hasObject(editor), 5_000))
            val (userField, passwordField) = device.findObjects(editor)
            userField.setText(username)
            passwordField.setText(password)
            button(R.string.advanced_connection).click()
            checkNotNull(device.wait(Condition<UiDevice, UiObject2?> { current ->
                current.findObjects(editor).getOrNull(2)
            }, 5_000)) { "The custom relay URL field did not appear" }.setText(relay)
            button(R.string.connect).click()
            val next = checkNotNull(device.wait(Condition<UiDevice, UiObject2?> { current ->
                current.findObject(By.text(decline)) ?: current.findObject(project)
            }, 30_000)) { "Fresh pairing did not show the notification offer or open the app" }
            if (next.text == decline) next.click()
            assertTrue("Fresh pairing did not open the bundled app", device.wait(Until.hasObject(project), 30_000))
            val profile = runBlocking { store.snapshots().single { it.profile.id !in previousProfiles }.profile }
            assertEquals(username, profile.username)
            assertNotNull("The saved host must have a registered device binding", profile.securityClient?.clientId)
            assertEquals(profile.id, runBlocking { store.selectedProfileId.first() })
        } catch (error: Throwable) {
            com.yepanywhere.mobile.UiFailureCapture.save("fresh-relay-pairing")
            throw error
        } finally {
            scenario.close()
            tabs.edit().apply { if (previousTabs == null) remove("state") else putString("state", previousTabs) }.commit()
            runBlocking {
                store.snapshots().filter { it.profile.id !in previousProfiles }.forEach { store.forget(it.profile.id) }
                if (previousSelection != null && store.snapshot(previousSelection) != null) store.select(previousSelection)
            }
        }
    }

    @Test
    fun displaysSavedHostsWithoutStartingDashboardConnections() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val wsUrl = arguments.getString("yaProbeWsUrl")
        val username = arguments.getString("yaProbeUsername")
        val password = arguments.getString("yaProbePassword")
        assumeTrue(
            "Native home integration arguments are intentionally absent in config-free CI",
            wsUrl != null && username != null && password != null,
        )
        val application = instrumentation.targetContext.applicationContext
            as YepAnywhereApplication
        val runtime = application.nativeRuntime
        val previouslySelected = runBlocking {
            runtime.pairedServers.selectedProfileId.first()
        }
        val profile = runBlocking {
            withTimeout(15_000) {
                runtime.pairing.pair(
                    label = "Disposable direct server",
                    username = checkNotNull(username),
                    password = checkNotNull(password),
                    route = YaServerRoute.direct(checkNotNull(wsUrl)),
                )
            }
        }

        val device = UiDevice.getInstance(instrumentation)
        val scenario = ActivityScenario.launch<MainActivity>(Intent(application, MainActivity::class.java).putExtra(MainActivity.SHOW_HOSTS, true))
        try {
            assertTrue(device.wait(Until.hasObject(By.text("Disposable direct server")), 5_000))
            assertTrue(device.wait(Until.hasObject(By.text("Open full app")), 5_000))
            assertEquals(YaConnectionPhase.IDLE, runtime.connectionManager(profile.id).state.value.phase)
        } finally {
            scenario.close()
            runBlocking {
                val manager = runtime.connectionManager(profile.id)
                withTimeout(5_000) {
                    manager.state.first { it.phase == YaConnectionPhase.IDLE }
                }
                assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)
                runtime.pairedServers.forget(profile.id)
                if (
                    previouslySelected != null &&
                    runtime.pairedServers.snapshot(previouslySelected) != null
                ) {
                    runtime.pairedServers.select(previouslySelected)
                }
            }
        }
    }
}
