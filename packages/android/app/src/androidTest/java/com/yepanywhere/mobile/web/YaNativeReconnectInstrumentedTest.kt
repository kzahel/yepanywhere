package com.yepanywhere.mobile.web

import android.content.Intent
import android.os.SystemClock
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.SYNTHETIC_RESPONSE_TAG
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.connection.YaServerConnectionManager
import com.yepanywhere.mobile.profiles.YaServerRoute
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The bundled web app rides out native connection churn without showing server
 * errors the server never sent (topics/mobile-server-pairing.md).
 * Scenarios that use the probe server's direct-socket controls run on the
 * direct route only.
 */
@RunWith(AndroidJUnit4::class)
class YaNativeReconnectInstrumentedTest {
    @get:org.junit.Rule
    val launcherAnrRecovery = com.yepanywhere.mobile.LauncherAnrRecoveryRule()

    /** Opt-in host-driven study. The real Activity, bridge, Kotlin and Rust stay live. */
    @Test
    fun hostDrivenLifecycleStudy() {
        assumeTrue("Only the lifecycle study runner owns this fixture",
            InstrumentationRegistry.getArguments().getString("yaLifecycleStudy") == "true")
        val detached = InstrumentationRegistry.getArguments().getString("yaLifecycleDetached") == "true"
        withLoadedSession("lifecycle-study", preserveForHost = detached) { session ->
            val directory = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "lifecycle-study")
            directory.mkdirs()
            val stop = java.io.File(directory, "stop")
            stop.delete()
            val ready = org.json.JSONObject().put("sessionPath", session.sessionPath)
            if (InstrumentationRegistry.getArguments().getString("yaLifecyclePush") == "true") {
                val context = InstrumentationRegistry.getInstrumentation().targetContext
                val runtime = (context.applicationContext as YepAnywhereApplication).nativeRuntime
                val profile = runBlocking { checkNotNull(runtime.pairedServers.selectedProfileId.first()) }
                runBlocking { withTimeout(40_000) {
                    while (com.yepanywhere.mobile.notifications.NotificationFoundation.installationStore(context).read()?.targetCurrent != true) kotlinx.coroutines.delay(100)
                    runtime.nativePush.enable(profile)
                } }
                ready.put("subscriptionId", checkNotNull(runtime.nativePush.bindings.get(profile)).subscriptionId)
            }
            java.io.File(directory, "ready.json").writeText(ready.toString())
            if (detached) return@withLoadedSession
            try {
                // Study observation window, not a product recovery deadline. The
                // host terminates each run; this bounds cleanup if it disappears.
                val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(10)
                while (!stop.exists() && System.nanoTime() < deadline) Thread.sleep(100)
                check(stop.exists()) { "Lifecycle study host did not finish" }
            } finally {
                java.io.File(directory, "phases.json").writeText(org.json.JSONArray(session.phases.toList()).toString())
                java.io.File(directory, "ready.json").delete()
            }
        }
    }

    /** Host-owned process-death studies restore their fixture in a new process. */
    @Test
    fun cleanupHostDrivenLifecycleStudy() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("yaLifecycleStudy") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = (context.applicationContext as YepAnywhereApplication).nativeRuntime
        val saved = context.getSharedPreferences("owned-lifecycle-study", android.content.Context.MODE_PRIVATE)
        val id = saved.getString("profile", null) ?: return@runBlocking
        val subscription = runtime.nativePush.bindings.get(id)?.subscriptionId
        runtime.nativePush.forget(id)
        check(runtime.nativePush.bindings.get(id) == null) { "Owned push capability cleanup failed" }
        if (subscription != null) {
            val notifications = context.getSystemService(android.app.NotificationManager::class.java)
            notifications.activeNotifications.filter { it.tag?.startsWith("$subscription:") == true }.forEach { notifications.cancel(it.tag, it.id) }
        }
        runtime.connectionManager(id).shutdownAndAwait()
        runtime.pairedServers.forget(id)
        val previous = saved.getString("previous", null)
        if (previous != null && runtime.pairedServers.snapshot(previous) != null) runtime.pairedServers.select(previous)
        context.getSharedPreferences("native-tabs", android.content.Context.MODE_PRIVATE).edit().apply {
            if (saved.contains("tabs")) putString("state", saved.getString("tabs", null)) else remove("state")
        }.commit()
        saved.edit().clear().commit()
    }

    @Test
    fun requestsMadeWhileNativeReconnectsShowNoSyntheticServerErrors() = withLoadedSession("held-resume", directOnly = true) { session ->
        session.probe("/__probe/resume-hold?enabled=true")
        session.probe("/__probe/disconnect")
        session.awaitNativeLeftConnected()
        // Ordinary demand while native reconnects: leave and reopen the session.
        session.navigate("/projects")
        Thread.sleep(2_000)
        session.navigate(session.sessionPath)
        Thread.sleep(3_000)
        session.probe("/__probe/resume-hold?enabled=false")
        session.assertRecoveredWithoutSyntheticErrors()
    }

    // Originally red on an API 35 emulator: pending requests became fake 503s.
    @Test
    fun requestsInFlightWhenNativeDisconnectsShowNoSyntheticServerErrors() = withLoadedSession("in-flight", directOnly = true) { session ->
        // Keep the page's requests pending at the server, then drop native's socket.
        session.probe("/__probe/api-delay?ms=3000")
        session.navigate("/projects")
        Thread.sleep(500)
        session.probe("/__probe/disconnect")
        session.awaitNativeLeftConnected()
        session.probe("/__probe/api-delay?ms=0")
        Thread.sleep(3_000)
        session.navigate(session.sessionPath)
        session.assertRecoveredWithoutSyntheticErrors()
    }

    @Test
    fun manyConcurrentRequestsOnASlowRouteShowNoSyntheticServerErrors() = withLoadedSession("slow-route", directOnly = true) { session ->
        // A slow route keeps the page's requests pending, so opening pages
        // stacks them on native's single session, as after a fresh relay login.
        session.probe("/__probe/api-delay?ms=3000")
        session.navigate("/projects")
        Thread.sleep(300)
        session.navigate(session.sessionPath)
        Thread.sleep(300)
        session.navigate("/projects")
        Thread.sleep(300)
        session.navigate(session.sessionPath)
        Thread.sleep(8_000)
        session.probe("/__probe/api-delay?ms=0")
        session.assertRecoveredWithoutSyntheticErrors()
    }

    @Test
    fun openingTheFirstSessionAfterAFreshLoginShowsNoSyntheticServerErrors() = withLoadedSession("fresh-login", recordFromLaunch = true) { session ->
        // The setup already paired, opened Projects and then the session the
        // moment the page loaded, recording from document start.
        Thread.sleep(10_000)
        session.assertRecoveredWithoutSyntheticErrors()
    }

    @Test
    fun refreshingTheSessionPageShowsNoSyntheticServerErrors() = withLoadedSession("refresh") { session ->
        // Pull-down refresh reloads the current route; repeat it as a user might.
        repeat(3) {
            session.reload()
            session.awaitSession()
        }
        session.assertRecoveredWithoutSyntheticErrors()
    }

    @Test
    fun refreshingRepeatedlyStaysConnected() = withLoadedSession("refresh-repeatedly") { session ->
        // More reloads in a minute than the relay's per-user circuit-open
        // budget (6), as a user retrying a stuck page might.
        repeat(7) {
            session.reload()
            session.awaitSession()
        }
        session.assertRecoveredWithoutSyntheticErrors()
    }

    @Test
    fun wakingTheScreenShowsNoSyntheticServerErrors() = withLoadedSession("screen-wake") { session ->
        // Prime both pages, then change server data while the real foreground
        // lease is absent. Session, cached Inbox and sidebar must agree on wake.
        session.navigate("/inbox")
        await(session.scenario, "!!document.querySelector('[data-inbox-toolbar]') && document.querySelector('main').textContent.includes('Android conversation fixture')")
        session.navigate(session.sessionPath)
        session.awaitSession()
        val document = evaluate(session.scenario, "performance.timeOrigin")
        recordPageProblems(session.scenario)
        val title = "Updated wake session"
        try {
            session.device.sleep()
            runBlocking { withTimeout(10_000) { session.manager.state.first { it.phase == YaConnectionPhase.IDLE } } }
            val message = session.probe("/__probe/append").getString("message")
            session.updateMetadata(title, true)
            Thread.sleep(20_000)
            session.wake()
            session.assertRecoveredWithoutSyntheticErrors()
            await(session.scenario, "document.body.textContent.includes(${org.json.JSONObject.quote(message)}) && document.querySelector('header').textContent.includes('$title')")
            session.navigate("/inbox")
            await(session.scenario, "!!document.querySelector('[data-inbox-toolbar]') && document.querySelector('main').textContent.includes('$title') && !document.querySelector('[data-connection-status]')")
            await(session.scenario, """!!document.querySelector('[aria-label="Open sidebar"]')""")
            evaluate(session.scenario, """document.querySelector('[aria-label="Open sidebar"]').click(); true""")
            await(session.scenario, "document.querySelector('#sidebar-starred-list')?.textContent.includes('$title') === true")
            assertEquals("Wake must preserve the mounted document", document, evaluate(session.scenario, "performance.timeOrigin"))
            assertEquals("No transient errors or sign-in; native phases=${session.phases}", "\"[]\"", evaluate(session.scenario, "JSON.stringify(window.__pageProblems)"))
        } finally { session.updateMetadata("Android conversation fixture", false) }
    }

    @Test
    fun wakingFromDozeShowsNoSyntheticServerErrors() = withLoadedSession("doze-wake") { session ->
        // A phone in a pocket: screen off, unplugged, then device idle.
        session.device.sleep()
        session.device.executeShellCommand("dumpsys battery unplug")
        try {
            Thread.sleep(2_000)
            session.device.executeShellCommand("dumpsys deviceidle force-idle")
            Thread.sleep(20_000)
        } finally {
            session.device.executeShellCommand("dumpsys deviceidle unforce")
            session.device.executeShellCommand("dumpsys battery reset")
        }
        session.wake()
        session.assertRecoveredWithoutSyntheticErrors()
    }

    // Retry exhaustion remains visibly recoverable. This fixture changes server
    // reachability, not Android connectivity, so recovery uses the slow backstop.
    @Test
    fun wakingBeforeTheNetworkReturnsShowsNoSyntheticServerErrors() = withLoadedSession("wake-outage", directOnly = true) { session ->
        // A phone out of a pocket: the screen is on before its network is back,
        // so native's reconnect attempts fail rather than wait.
        session.device.sleep()
        session.probe("/__probe/outage?enabled=true")
        Thread.sleep(20_000)
        session.wake()
        Thread.sleep(8_000)
        await(session.scenario, "document.querySelector('[data-connection-status=connecting]') !== null")
        assertTrue(session.manager.state.value.recoverable)
        session.probe("/__probe/outage?enabled=false")
        // Two measured passive runs took ~57 s after restoration. 120 s is
        // 2x that observed maximum and includes the unchanged 60 s backstop.
        session.assertRecoveredWithoutSyntheticErrors(timeoutSeconds = 120)
    }

    @Test
    fun nativeNetworkRestorationRestartsAnExhaustedSource() {
        assumeTrue("Radio controls belong only to the owned emulator", android.os.Build.HARDWARE == "ranchu")
        withLoadedSession("network-restoration", directOnly = true) { session ->
            recordPageProblems(session.scenario)
            try {
                session.probe("/__probe/outage?enabled=true")
                session.device.executeShellCommand("svc wifi disable")
                session.device.executeShellCommand("svc data disable")
                await(session.scenario, "navigator.onLine === false")
                runBlocking { withTimeout(15_000) { session.manager.state.first { it.phase == YaConnectionPhase.FAILED } } }
                assertTrue(session.manager.state.value.recoverable)
                session.navigate("/inbox")
                await(session.scenario, "!!document.querySelector('[data-connection-status=connecting]')")
                session.probe("/__probe/outage?enabled=false")
                session.device.executeShellCommand("svc wifi enable")
                session.device.executeShellCommand("svc data enable")
                // No typing, page reload or synthetic JS online event. The
                // real platform callback must recover before the 60 s timer.
                await(session.scenario, "!!document.querySelector('[data-inbox-toolbar]') && !document.querySelector('[data-connection-status]')")
                assertEquals("Radio loss must not become a page error or sign-in", "\"[]\"", evaluate(session.scenario, "JSON.stringify(window.__pageProblems)"))
                session.navigate(session.sessionPath)
                session.assertRecoveredWithoutSyntheticErrors()
            } finally {
                session.device.executeShellCommand("svc wifi enable")
                session.device.executeShellCommand("svc data enable")
            }
        }
    }

    // Refresh after exhausted wake recovery must not fabricate server errors.
    @Test
    fun refreshingAfterAFailedWakeShowsNoSyntheticServerErrors() = withLoadedSession("wake-outage-refresh", directOnly = true) { session ->
        // As above, then the user refreshes once the network is back.
        session.device.sleep()
        session.probe("/__probe/outage?enabled=true")
        Thread.sleep(20_000)
        session.wake()
        Thread.sleep(8_000)
        session.probe("/__probe/outage?enabled=false")
        Thread.sleep(3_000)
        session.reload()
        Thread.sleep(10_000)
        session.assertRecoveredWithoutSyntheticErrors()
    }

    @Test
    fun turningTheScreenOffWithRequestsPendingShowsNoSyntheticServerErrors() = withLoadedSession("sleep-pending", directOnly = true) { session ->
        // Backgrounding releases the page's native lease while its requests
        // are still waiting on the server.
        session.probe("/__probe/api-delay?ms=3000")
        session.navigate("/projects")
        Thread.sleep(500)
        session.device.sleep()
        Thread.sleep(5_000)
        session.probe("/__probe/api-delay?ms=0")
        session.wake()
        session.navigate(session.sessionPath)
        session.assertRecoveredWithoutSyntheticErrors()
    }

    private class LoadedSession(
        val device: UiDevice,
        val scenario: ActivityScenario<MainActivity>,
        val manager: YaServerConnectionManager,
        val sessionPath: String,
        val phases: List<String>,
        private val http: OkHttpClient,
        private val base: String,
        private val test: YaNativeReconnectInstrumentedTest,
    ) {
        fun probe(path: String) = http.newCall(Request.Builder().url("$base$path").post(ByteArray(0).toRequestBody()).build()).execute().use {
            assertTrue("Probe $path failed: ${it.code}", it.isSuccessful)
            org.json.JSONObject(checkNotNull(it.body).string())
        }

        fun updateMetadata(title: String, starred: Boolean) {
            val body = org.json.JSONObject().put("title", title).put("starred", starred).toString()
            http.newCall(Request.Builder().url("$base/api/sessions/android-preview-session/metadata")
                .header("X-Yep-Anywhere", "true").put(body.toRequestBody("application/json".toMediaType())).build())
                .execute().use { assertTrue("Metadata fixture update failed: ${it.code}", it.isSuccessful) }
        }

        fun navigate(path: String) = test.navigate(scenario, path)

        fun reload() = test.evaluate(scenario, "location.reload(); true")

        fun awaitSession() = test.await(scenario, "document.body.textContent.includes('Preview message 50')")

        fun wake() {
            device.wakeUp()
            device.executeShellCommand("wm dismiss-keyguard")
            test.await(scenario, "document.visibilityState === 'visible'")
        }

        fun awaitNativeLeftConnected() {
            runBlocking { withTimeout(10_000) { manager.state.first { it.phase != YaConnectionPhase.CONNECTED } } }
        }

        fun assertRecoveredWithoutSyntheticErrors(timeoutSeconds: Long = 30) {
            test.await(scenario, "document.body.textContent.includes('Preview message 50') && !document.querySelector('[data-connection-status]')", timeoutSeconds)
            // The page recorder covers the current document; native's log
            // covers every document, including ones a reload replaced.
            val synthetic = device.executeShellCommand("logcat -d -s $SYNTHETIC_RESPONSE_TAG:W").lines()
                .filter { it.contains("Synthetic 503") }
            val errors = test.evaluate(scenario, "JSON.stringify(window.__syntheticErrors ?? [])")
            assertEquals("Native fabricated responses; native phases=$phases", emptyList<String>(), synthetic)
            assertEquals("Page showed errors the server never sent; native phases=$phases", "\"[]\"", errors)
            val ui = test.evaluate(scenario, "JSON.stringify(window.__nativeStatusEdges ?? [])")
            scenario.onActivity { activity ->
                val proof = activity.nativeTransportDiagnostics() ?: org.json.JSONObject()
                proof.remove("profileId")
                proof.put("nativePhases", org.json.JSONArray(phases.map { it.substringBefore(" attempt=") }))
                proof.put("uiEdges", org.json.JSONArray(org.json.JSONTokener(ui).nextValue() as String))
                InstrumentationRegistry.getInstrumentation().sendStatus(2, android.os.Bundle().apply { putString("yaNativeRecoveryProof", proof.toString()) })
            }
        }
    }

    private fun withLoadedSession(
        name: String,
        directOnly: Boolean = false,
        recordFromLaunch: Boolean = false,
        preserveForHost: Boolean = false,
        body: (LoadedSession) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val ws = args.getString("yaProbeWsUrl")
        val username = args.getString("yaProbeUsername")
        val password = args.getString("yaProbePassword")
        assumeTrue("Disposable probe arguments absent in config-free CI", ws != null && username != null && password != null)
        val relayWs = args.getString("yaProbeRelayWsUrl")
        assumeTrue("Direct-route scenario", !directOnly || relayWs == null)
        val device = UiDevice.getInstance(instrumentation)
        if (recordFromLaunch) device.executeShellCommand("logcat -c")
        val application = instrumentation.targetContext.applicationContext as YepAnywhereApplication
        val runtime = application.nativeRuntime
        val saved = application.getSharedPreferences("owned-lifecycle-study", android.content.Context.MODE_PRIVATE)
        if (preserveForHost) check(!saved.contains("profile")) { "Clean the previous host-driven study first" }
        val previous = runBlocking { runtime.pairedServers.selectedProfileId.first() }
        val profile = runBlocking { withTimeout(15_000) {
            withContext(Dispatchers.Main) {
                runtime.pairing.pair("Reconnect probe ${java.util.UUID.randomUUID().toString().take(8)}",
                    checkNotNull(username), checkNotNull(password),
                    if (relayWs == null) YaServerRoute.direct(checkNotNull(ws)) else YaServerRoute.relay(relayWs, checkNotNull(username)))
            }
        } }
        val manager = runtime.connectionManager(profile.id)
        val started = SystemClock.elapsedRealtime()
        val phases = Collections.synchronizedList(mutableListOf<String>())
        val watcher = CoroutineScope(Dispatchers.Default)
        watcher.launch { manager.state.collect { phases += "${SystemClock.elapsedRealtime() - started}ms ${it.phase} attempt=${it.retryAttempt} ${it.errorMessage ?: ""}".trim() } }
        val preferences = application.getSharedPreferences("native-tabs", android.content.Context.MODE_PRIVATE)
        val previousTabs = preferences.getString("state", null)
        if (preserveForHost) {
            saved.edit().putString("profile", profile.id).putString("previous", previous)
                .putString("tabs", previousTabs).commit()
        }
        var prepared = false
        preferences.edit().remove("state").commit()
        runBlocking { runtime.pairedServers.select(profile.id) }
        val base = checkNotNull(ws).replace("ws://", "http://").replace("wss://", "https://").substringBefore("/api/ws")
        val http = OkHttpClient()
        val scenario = ActivityScenario.launch<MainActivity>(
            Intent(application, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))
        var session: LoadedSession? = null
        try {
            if (recordFromLaunch) {
                await(scenario, "document.readyState === 'complete'")
                recordSyntheticErrors(scenario)
            }
            await(scenario, "document.body.textContent.includes('preview-project')")
            val lookup = runBlocking { manager.acquire() }
            val projects = try {
                runBlocking { lookup.request("GET", "/projects").body } as org.json.JSONObject
            } finally {
                runBlocking { lookup.releaseAndAwait() }
            }
            val projectId = projects.getJSONArray("projects").getJSONObject(0).getString("id")
            val sessionPath = "/projects/$projectId/sessions/android-preview-session"
            navigate(scenario, sessionPath)
            await(scenario, "document.body.textContent.includes('Preview message 50')")
            if (!recordFromLaunch) recordSyntheticErrors(scenario)
            if (!recordFromLaunch) device.executeShellCommand("logcat -c")
            session = LoadedSession(device, scenario, manager, sessionPath, phases, http, base, this)
            body(session)
            prepared = true
        } catch (error: Throwable) {
            com.yepanywhere.mobile.UiFailureCapture.save("native-reconnect-$name", "phases=$phases; manager=${manager.state.value}")
            throw error
        } finally {
            if (!device.isScreenOn) runCatching { device.wakeUp(); device.executeShellCommand("wm dismiss-keyguard") }
            runCatching { session?.probe("/__probe/resume-hold?enabled=false") }
            runCatching { session?.probe("/__probe/api-delay?ms=0") }
            runCatching { session?.probe("/__probe/outage?enabled=false") }
            watcher.cancel()
            scenario.close()
            if (!preserveForHost || !prepared) {
                preferences.edit().apply { if (previousTabs == null) remove("state") else putString("state", previousTabs) }.commit()
                try {
                    // Later relay probes count live circuits; leave none behind.
                    runBlocking { withTimeout(10_000) { manager.state.first { it.phase == YaConnectionPhase.IDLE } } }
                    args.getString("yaProbeRelayStatusUrl")?.let { awaitRelayDrained(http, it) }
                } finally {
                    http.connectionPool.evictAll()
                    http.dispatcher.executorService.shutdown()
                    runBlocking {
                        runtime.nativePush.forget(profile.id)
                        runtime.pairedServers.forget(profile.id)
                        if (previous != null && runtime.pairedServers.snapshot(previous) != null) runtime.pairedServers.select(previous)
                    }
                }
                if (preserveForHost) saved.edit().clear().commit()
            } else {
                http.connectionPool.evictAll()
                http.dispatcher.executorService.shutdown()
            }
        }
    }

    /** Fails with the relay's counts if this app still holds a circuit or socket. */
    private fun awaitRelayDrained(http: OkHttpClient, statusUrl: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var mux = org.json.JSONObject()
        while (System.nanoTime() < deadline) {
            mux = http.newCall(Request.Builder().url(statusUrl).build()).execute().use {
                org.json.JSONObject(checkNotNull(it.body).string()).getJSONObject("mux")
            }
            if (mux.getInt("liveCircuits") == 0 && mux.getInt("physicalSockets") == 0) return
            Thread.sleep(100)
        }
        throw AssertionError("Relay still holds this app's connections after native went idle: $mux")
    }

    private fun recordPageProblems(scenario: ActivityScenario<MainActivity>) {
        evaluate(scenario, """
            (() => {
              window.__pageProblems = [];
              const sample = () => {
                const errors = [...document.querySelectorAll('.error, [role="alert"], [class*="errorMessage"]')]
                  .filter(e => e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true}))
                  .map(e => e.textContent.trim()).filter(Boolean);
                if (errors.length || location.pathname.includes('/login'))
                  window.__pageProblems.push({path:location.pathname, errors});
              };
              new MutationObserver(sample).observe(document.body, {subtree:true, childList:true, characterData:true});
              window.addEventListener('popstate', sample); sample(); return true;
            })()
        """.trimIndent())
    }

    /**
     * Records every synthetic native error the page shows or logs from here on.
     * Real server errors, such as the fixture's unavailable notification
     * service, are not matched.
     */
    private fun recordSyntheticErrors(scenario: ActivityScenario<MainActivity>) {
        evaluate(scenario, """
            (() => {
              window.__syntheticErrors = [];
              window.__nativeStatusEdges = [];
              let lastStatus;
              const sampleStatus = () => {
                const state = document.querySelector('[data-connection-status]')?.getAttribute('data-connection-status') ?? 'ready';
                if (state !== lastStatus) {
                  lastStatus = state;
                  if (window.__nativeStatusEdges.length === 128) window.__nativeStatusEdges.shift();
                  window.__nativeStatusEdges.push({atMs:Math.round(performance.now()),state});
                }
              };
              new MutationObserver(sampleStatus).observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['data-connection-status']});
              sampleStatus();
              const pattern = /Native connection unavailable/;
              const note = (source, text) => {
                const match = String(text).match(/[^\n]{0,80}Native connection unavailable[^\n]{0,80}/);
                if (match) window.__syntheticErrors.push({at: Math.round(performance.now()), source, text: match[0]});
              };
              new MutationObserver(() => {
                const text = document.body.textContent;
                if (pattern.test(text)) note('dom', text);
              }).observe(document.body, {subtree: true, childList: true, characterData: true});
              for (const level of ['error', 'warn']) {
                const original = console[level].bind(console);
                console[level] = (...values) => { note('console.' + level, values.map(String).join(' ')); original(...values); };
              }
              return true;
            })()
        """.trimIndent())
    }

    /** Client-side route change, so the document and its recorder survive. */
    private fun navigate(scenario: ActivityScenario<MainActivity>, path: String) {
        evaluate(scenario, "history.pushState({}, '', '$path'); dispatchEvent(new PopStateEvent('popstate')); true")
    }

    // Matches YaNativeWebAppInstrumentedTest: 30 s is ~3x the slowest observed
    // document readiness on the emulator testbed.
    private fun await(scenario: ActivityScenario<MainActivity>, script: String, timeoutSeconds: Long = 30) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
        var actual = ""
        while (System.nanoTime() < deadline) {
            var ready = false
            scenario.onActivity { activity ->
                ready = activity.nativeTransportDiagnostics() != null && activity.findViewById<WebView>(R.id.web_client)?.progress == 100
            }
            if (!ready) { Thread.sleep(100); continue }
            actual = evaluate(scenario, script)
            if (actual == "true") return
            Thread.sleep(100)
        }
        val page = evaluate(scenario, "JSON.stringify({path: location.pathname, body: document.body.textContent.slice(0, 1200), errors: window.__syntheticErrors})")
        throw AssertionError("Expected $script; got $actual; page=$page")
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val result = AtomicReference<String>()
        val done = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.web_client).evaluateJavascript(script) { result.set(it); done.countDown() }
        }
        assertTrue("JavaScript callback timed out", done.await(5, TimeUnit.SECONDS))
        return result.get()
    }
}
