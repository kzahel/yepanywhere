package com.yepanywhere.mobile.ui

import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaServerRoute
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Run against android-native-secure-probe-server with conversation fixtures enabled. */
@RunWith(AndroidJUnit4::class)
class YaConversationInstrumentedTest {
    @Test fun browsesLiveHistoryAndReleasesTheSourceOnBack() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val wsUrl = args.getString("yaProbeWsUrl")
        val username = args.getString("yaProbeUsername")
        val password = args.getString("yaProbePassword")
        assumeTrue("Disposable probe arguments are absent in config-free CI", wsUrl != null && username != null && password != null)
        val context = instrumentation.targetContext
        val runtime = (context.applicationContext as YepAnywhereApplication).nativeRuntime
        val selected = runBlocking { runtime.pairedServers.selectedProfileId.first() }
        val profile = runBlocking { withTimeout(15000) {
            runtime.pairing.pair("Conversation AVD server", checkNotNull(username), checkNotNull(password), YaServerRoute.direct(checkNotNull(wsUrl)))
        } }
        val device = UiDevice.getInstance(instrumentation)
        fun visible(text: String) { assertTrue("Missing: $text", device.wait(Until.hasObject(By.text(text)), 15000)) }
        fun scrollTo(text: String) {
            if (device.hasObject(By.text(text))) return
            // Compose lazy rows are virtualized; use real vertical swipes rather
            // than UiScrollable's legacy widget end-of-list inference.
            val down = text.startsWith("Live preview response") || text == "Android conversation fixture"
            repeat(25) {
                if (device.hasObject(By.text(text))) return
                val top = device.displayHeight / 4
                val bottom = device.displayHeight * 4 / 5
                device.swipe(device.displayWidth / 2, if (down) bottom else top,
                    device.displayWidth / 2, if (down) top else bottom, 25)
                device.waitForIdle()
            }
            visible(text)
        }
        fun click(text: String) { scrollTo(text); device.findObject(By.text(text)).click() }
        fun control(name: String): JSONObject {
            val endpoint = checkNotNull(wsUrl).replace("ws://", "http://").replace("/api/ws", "/__probe/$name")
            val connection = URL(endpoint).openConnection() as HttpURLConnection
            try { connection.requestMethod = "POST"; connection.connectTimeout = 5000; connection.readTimeout = 5000; assertEquals(200, connection.responseCode); return JSONObject(connection.inputStream.bufferedReader().use { it.readText() }) }
            finally { connection.disconnect() }
        }
        fun capture(name: String) {
            val dir = File(context.getExternalFilesDir(null), "conversation-captures").apply { mkdirs() }
            device.waitForIdle()
            assertTrue(device.takeScreenshot(File(dir, "$name.png")))
        }
        Intents.init()
        Intents.intending(hasAction(Intent.ACTION_VIEW)).respondWith(android.app.Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null))
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            visible("Connected")
            click("Android conversation fixture")
            visible("Conversation preview")
            visible("20 messages")
            assertFalse(device.hasObject(By.clazz("android.webkit.WebView")))
            capture("portrait")
            click("Show more")
            visible("40 messages")
            visible("Showing an anchored history window. Latest returns to the live tail.")
            click("Latest")
            visible("40 messages")
            assertTrue(device.wait(Until.gone(By.text("Loading conversation…")), 15000))
            val liveMessage = control("append").getString("message")
            scrollTo(liveMessage)
            capture("live-tail")
            scrollTo("Open full session")
            device.setOrientationLeft()
            visible("Conversation preview")
            capture("landscape")
            device.setOrientationNatural()
            scrollTo("Open full session")
            click("Open full session")
            Intents.intended(hasAction(Intent.ACTION_VIEW))
            val handoff = Intents.getIntents().last { it.action == Intent.ACTION_VIEW }
            assertTrue(checkNotNull(handoff.dataString).startsWith(checkNotNull(wsUrl).replace("ws://", "http://").removeSuffix("/api/ws") + "/projects/"))
            assertTrue(checkNotNull(handoff.dataString).endsWith("/sessions/android-preview-session"))
            control("disconnect")
            visible("Reconnect")
            click("Reconnect")
            assertTrue(device.wait(Until.gone(By.text("Reconnect")), 15000))
            assertTrue(device.wait(Until.gone(By.text("Loading conversation…")), 15000))
            visible("40 messages")
            device.pressHome()
            runBlocking { withTimeout(5000) { runtime.connectionManager(profile.id).state.first { it.phase == YaConnectionPhase.IDLE } } }
            // Bring the existing task back; its top Conversation activity resumes.
            context.getSystemService(ActivityManager::class.java).appTasks.first {
                it.taskInfo.baseActivity?.className == MainActivity::class.java.name
            }.moveToFront()
            visible("Conversation preview")
            assertTrue(device.wait(Until.gone(By.text("Loading conversation…")), 15000))
            visible("40 messages")
            scrollTo(control("append").getString("message"))
            click("Back")
            visible("Connected")
        } catch (error: Throwable) {
            val dir = File(context.getExternalFilesDir(null), "conversation-captures").apply { mkdirs() }
            device.dumpWindowHierarchy(File(dir, "failure.xml"))
            device.takeScreenshot(File(dir, "failure.png"))
            throw error
        } finally {
            device.setOrientationNatural()
            device.unfreezeRotation()
            // Close any top child before ActivityScenario tears down the home.
            if (device.hasObject(By.text("Conversation preview"))) device.pressBack()
            scenario.close()
            Intents.release()
            runBlocking {
                withTimeout(5000) { runtime.connectionManager(profile.id).state.first { it.phase == YaConnectionPhase.IDLE } }
                runtime.pairedServers.forget(profile.id)
                if (selected != null && runtime.pairedServers.snapshot(selected) != null) runtime.pairedServers.select(selected)
            }
        }
    }
}
