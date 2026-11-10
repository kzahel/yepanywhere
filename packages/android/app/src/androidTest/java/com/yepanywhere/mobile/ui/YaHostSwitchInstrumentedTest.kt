package com.yepanywhere.mobile.ui

import android.content.Intent
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.web.WebClientActivity
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Owns one profile and no sibling lease: ordinary switching must fully stop it. */
@RunWith(AndroidJUnit4::class)
class YaHostSwitchInstrumentedTest {
    @get:org.junit.Rule
    val launcherAnrRecovery = com.yepanywhere.mobile.LauncherAnrRecoveryRule()
    private val hostLabel = "Host switch probe ${java.util.UUID.randomUUID().toString().take(8)}"
    @Test fun switchDuringResumeDoesNotSignOutAndReopensWithoutPassword() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val ws = args.getString("yaProbeWsUrl")
        val username = args.getString("yaProbeUsername")
        val password = args.getString("yaProbePassword")
        assumeTrue("Disposable probe arguments absent", ws != null && username != null && password != null)
        val app = instrumentation.targetContext.applicationContext as YepAnywhereApplication
        val runtime = app.nativeRuntime
        val previous = runBlocking { runtime.pairedServers.selectedProfileId.first() }
        val profile = runBlocking { runtime.pairing.pair(hostLabel, checkNotNull(username), checkNotNull(password), YaServerRoute.direct(checkNotNull(ws))) }
        val manager = runtime.connectionManager(profile.id)
        val http = OkHttpClient()
        val base = checkNotNull(ws).replace("ws://", "http://").substringBefore("/api/ws")
        fun control(path: String, post: Boolean = true): JSONObject {
            val request = Request.Builder().url("$base/__probe/$path")
            if (post) request.post(ByteArray(0).toRequestBody())
            return http.newCall(request.build()).execute().use {
                assertTrue(it.isSuccessful)
                JSONObject(checkNotNull(it.body).string())
            }
        }
        val device = UiDevice.getInstance(instrumentation)
        val preferences = app.getSharedPreferences("native-tabs", android.content.Context.MODE_PRIVATE)
        val previousTabs = preferences.getString("state", null)
        preferences.edit().remove("state").commit()
        val main = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra(MainActivity.SHOW_HOSTS, true))
        try {
            var documentIdentity: String? = null
            repeat(2) { attempt ->
                // Scroll the owned card fully into view. A clipped LazyColumn
                // card must never fall back to another saved host's Open button.
                hostCard(device).findObject(By.text("Open full app")).click()
                try { waitFor { evaluate("document.body.textContent.includes('preview-project')") == "true" } }
                catch (error: Throwable) {
                    var diagnostics = ""
                    main.onActivity { diagnostics = it.nativeTransportDiagnostics().toString() }
                    throw AssertionError("manager=${manager.state.value}; native=$diagnostics", error)
                }
                runBlocking { withTimeout(10_000) { manager.state.first { it.phase == YaConnectionPhase.CONNECTED } } }
                val identity = evaluate("performance.timeOrigin")
                if (documentIdentity == null) documentIdentity = identity else assertEquals(documentIdentity, identity)
                if (attempt == 1) {
                    control("resume-hold?enabled=true")
                    control("disconnect")
                    waitFor { control("resume-hold", false).getInt("heldResumes") > 0 }
                    assertNull(runBlocking { runtime.pairedServers.snapshot(profile.id)?.resumeCredential })
                }
                evaluate("if (!document.querySelector('[data-sidebar-switch-host]')) document.querySelector('[data-sidebar-toggle]')?.click(); true")
                waitFor { evaluate("!!document.querySelector('[data-sidebar-switch-host]')") == "true" }
                evaluate("document.querySelector('[data-sidebar-switch-host]').click(); true")
                assertTrue(device.wait(Until.hasObject(By.text("Servers")), 5_000))
                runBlocking { withTimeout(10_000) {
                    manager.state.first { it.phase == YaConnectionPhase.IDLE }
                    while (runtime.pairedServers.snapshot(profile.id)?.resumeCredential?.isEligibleAt(System.currentTimeMillis()) != true) delay(25)
                } }
                control("resume-hold?enabled=false")
                instrumentation.waitForIdleSync()
                waitFor { hostCard(device).hasObject(By.text("Idle")) }
                assertFalse("Valid saved credential must not leave a sign-in warning after Switch Host", hostCard(device).hasObject(By.text("Sign-in required")))
                assertTrue(device.takeScreenshot(File(app.getExternalFilesDir(null), "host-switch-$attempt.png")))
            }
            hostCard(device).findObject(By.text("Open full app")).click()
            waitFor { evaluate("document.body.textContent.includes('preview-project')") == "true" }
            // The retained page is visible before transport finishes resuming.
            runBlocking { withTimeout(10_000) { manager.state.first { it.phase == YaConnectionPhase.CONNECTED } } }
            assertEquals(YaConnectionPhase.CONNECTED, manager.state.value.phase)
        } catch (error: Throwable) {
            com.yepanywhere.mobile.UiFailureCapture.save("host-switch")
            throw error
        } finally {
            control("resume-hold?enabled=false")
            instrumentation.runOnMainSync {
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<WebClientActivity>().forEach { it.finish() }
            }
            main.close()
            preferences.edit().apply { if (previousTabs == null) remove("state") else putString("state", previousTabs) }.commit()
            runBlocking {
                withTimeout(10_000) { manager.state.first { it.phase == YaConnectionPhase.IDLE } }
                runtime.pairedServers.forget(profile.id)
                if (previous != null && runtime.pairedServers.snapshot(previous) != null) runtime.pairedServers.select(previous)
            }
            http.connectionPool.evictAll()
            http.dispatcher.executorService.shutdown()
        }
    }

    private fun hostCard(device: UiDevice): UiObject2 {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val label = device.findObject(By.text(hostLabel))
            var node = label?.parent
            while (node != null) {
                val buttons = node.findObjects(By.text("Open full app"))
                if (buttons.size == 1 && buttons.single().visibleBounds.top >= checkNotNull(label).visibleBounds.bottom) return node
                node = node.parent
            }
            val list = device.findObject(By.scrollable(true))
            if (list != null) list.scroll(Direction.DOWN, 0.4f)
            else Thread.sleep(50)
        }
        error("Owned fixture host card is unavailable")
    }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) { if (condition()) return; Thread.sleep(50) }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        UiDevice.getInstance(instrumentation).takeScreenshot(File(instrumentation.targetContext.getExternalFilesDir(null), "host-switch-failure.png"))
        error("Host switch condition did not settle: " + evaluate("JSON.stringify({url:location.href, body:document.body.innerText.slice(0,1500), native:typeof window.yaNativeTransport})"))
    }
    private fun evaluate(script: String): String {
        val result = AtomicReference("false")
        val done = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<WebClientActivity>().singleOrNull()
            val view = activity?.findViewById<WebView>(R.id.web_client)
            if (view == null) done.countDown()
            else view.evaluateJavascript(script) { result.set(it); done.countDown() }
        }
        assertTrue("WebView callback timed out", done.await(5, TimeUnit.SECONDS))
        return result.get()
    }
}
