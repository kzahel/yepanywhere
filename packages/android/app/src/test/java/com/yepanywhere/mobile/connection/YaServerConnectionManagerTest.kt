package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.experimental.ConversationQuery
import com.yepanywhere.mobile.experimental.CONVERSATION_API_REVISION
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaPairedServerSnapshot
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import com.yepanywhere.mobile.security.YaSecurityClientLifecycle
import com.yepanywhere.mobile.security.YaSecurityClientRevokedException
import com.yepanywhere.mobile.web.YaWebTransportSession
import java.util.concurrent.CopyOnWriteArrayList
import java.nio.ByteBuffer
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class YaServerConnectionManagerTest {
    @Test
    fun drainsEventsWhileResumeSecurityBookkeepingIsPending() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val checking = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var calls = 0
        val manager = fixture.manager(securityClients = YaSecurityClientLifecycle { _, _ ->
            if (++calls > 1) { checking.complete(Unit); finish.await() }
            fixture.profile
        })
        val lease = manager.acquire()
        try {
            withTimeout(2000) { manager.state.first { it.phase == YaConnectionPhase.CONNECTED } }
            val subscription = lease.subscribe(channel = "activity")
            val event = async(start = CoroutineStart.UNDISPATCHED) { subscription.events.first() }
            val id = transport.awaitSent("subscribe").getString("subscriptionId")
            transport.incoming.send(JSONObject().put("type", "state").put("phase", "RETRYING"))
            transport.incoming.send(JSONObject().put("type", "state").put("phase", "CONNECTED"))
            withTimeout(2000) { checking.await() }
            transport.incoming.send(JSONObject().put("type", "event").put("subscriptionId", id)
                .put("eventType", "message").put("eventId", "1").put("data", "catch-up"))
            assertEquals("catch-up", withTimeout(2000) { event.await() }.data)
            assertFalse(finish.isCompleted)
            subscription.close()
        } finally { finish.complete(Unit); lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun restoresBeforePublishingTheTransportToANewSubscriber() = runBlocking {
        val fixture = Fixture()
        val manager = fixture.manager()
        val lease = manager.acquire()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val subscribed = CompletableDeferred<YaSubscription>()
        val watcher = scope.launch {
            manager.state.collect { state ->
                if (state.phase == YaConnectionPhase.CONNECTED && !subscribed.isCompleted) {
                    scope.launch(start = CoroutineStart.UNDISPATCHED) {
                        subscribed.complete(lease.subscribe("glossary", projectId = "project"))
                    }
                }
            }
        }
        val transport = FakeTransport(fixture.credential)
        try {
            fixture.connector.results.send(Result.success(transport))
            withTimeout(2_000) { subscribed.await(); transport.receiveStarted.await() }
            assertEquals(1, transport.sent.count { it.optString("type") == "subscribe" })
        } finally { watcher.cancel(); scope.cancel(); lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }
    @Test
    fun responseOwnershipSurvivesSiblingReleaseAndRejectsLateAdmission() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val first = manager.acquire()
        val sibling = manager.acquire()
        try {
            val body = FakeBody()
            transport.body = body
            val opened = first.fetchResponse("/movie", mapOf("Range" to "bytes=-17"))
            assertEquals("bytes=-17", transport.bodyParams!!.getJSONObject("headers").getString("Range"))
            sibling.releaseAndAwait()
            assertFalse(body.closed)
            first.releaseAndAwait()
            assertTrue(body.closed)
            assertTrue(runCatching { opened.nextChunk() }.isFailure)

            val second = FakeTransport(fixture.credential)
            fixture.connector.results.send(Result.success(second))
            val next = manager.acquire()
            val admission = CompletableDeferred<Unit>()
            val finish = CompletableDeferred<YaResponseBody>()
            second.bodyGate = { admission.complete(Unit); finish.await() }
            val late = async { runCatching { next.fetchResponse("/movie", emptyMap()) } }
            admission.await()
            next.releaseAndAwait()
            val unused = FakeBody()
            finish.complete(unused)
            assertTrue(late.await().isFailure)
            assertTrue(unused.closed)
        } finally { first.close(); sibling.close(); manager.shutdownAndAwait() }
    }

    @Test
    fun canceledResponseAdmissionClosesEvenAfterItsReplyWasQueued() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        val body = FakeBody()
        transport.body = body
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val lease = manager.acquire()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val emitted = CopyOnWriteArrayList<JSONObject>()
        val web = YaWebTransportSession("document", lease, scope, { emitted += it }) {}
        try {
            web.dispatch(JSONObject().put("handle", "document").put("id", "admission").put("method", "responseStart")
                .put("params", JSONObject().put("path", "/movie")))
            withTimeout(2_000) { while (emitted.none { it.optString("id") == "admission" }) delay(1) }
            assertFalse(body.closed)
            web.dispatch(JSONObject().put("handle", "document").put("id", "cancel-command").put("method", "cancel")
                .put("params", JSONObject().put("id", "admission")))
            assertTrue(body.closed)
        } finally { web.close(); scope.cancel(); manager.shutdownAndAwait() }
    }

    private class FakeBody : YaResponseBody {
        var closed = false
        override val metadata = JSONObject().put("streaming", true).put("status", 200)
        override suspend fun nextChunk(): ByteArray? { check(!closed); return null }
        override fun close() { closed = true }
    }
    @Test
    fun nativeSubscriptionFailureRetiresIntentAndPreservesItsCodeAcrossTheBridge() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val lease = manager.acquire()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val emitted = CopyOnWriteArrayList<JSONObject>()
        val web = YaWebTransportSession("document", lease, scope, { emitted += it }) {}
        try {
            web.dispatch(JSONObject().put("handle", "document").put("id", "setup").put("method", "subscribe")
                .put("params", JSONObject().put("subscriptionId", "local").put("channel", "activity")))
            val wire = transport.awaitSent("subscribe").getString("subscriptionId")
            transport.incoming.send(JSONObject().put("type", "subscriptionError").put("subscriptionId", wire)
                .put("errorCode", "OVERFLOW").put("error", "Too many subscriptions"))
            withTimeout(2_000) { while (emitted.none { it.optString("type") == "subscriptionError" }) delay(1) }
            val error = emitted.first { it.optString("type") == "subscriptionError" }
            assertEquals("local", error.getString("subscriptionId"))
            assertEquals("OVERFLOW", error.getString("errorCode"))
            assertFalse(error.has("status"))
            assertEquals(wire, transport.awaitSent("unsubscribe").getString("subscriptionId"))
            val next = FakeTransport(fixture.credential)
            fixture.connector.results.send(Result.success(next))
            lease.reconnect()
            assertTrue(next.sent.none { it.optString("type") == "subscribe" })
        } finally { web.close(); scope.cancel(); manager.shutdownAndAwait() }
    }

    @Test
    fun terminalFailureAfterReadinessRejectsNewDemandWithoutSpinning() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val lease = manager.acquire()
        try {
            lease.subscribe("activity")
            transport.incoming.send(JSONObject().put("type", "state").put("phase", "FAILED").put("recoverable", false))
            withTimeout(2_000) { manager.state.first { it.phase == YaConnectionPhase.FAILED } }
            val error = withTimeout(2_000) { runCatching { lease.request("GET", "/sessions") }.exceptionOrNull() }
            assertTrue(error is YaConnectionUnavailableException)
            assertEquals(1, fixture.connector.resumeCalls)
        } finally { lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun exhaustedNetworkRecoveryKeepsCredentialAndCanBeRestarted() = runBlocking {
        val fixture = Fixture()
        repeat(2) { fixture.connector.results.send(Result.failure(java.io.IOException("offline"))) }
        val manager = fixture.manager(retryDelaysMs = listOf(0))
        val lease = manager.acquire()
        try {
            val failed = withTimeout(2_000) { manager.state.first { it.phase == YaConnectionPhase.FAILED } }
            assertTrue(failed.recoverable)
            assertEquals(2, fixture.connector.resumeCalls)
            assertFalse(fixture.repository.credentialCleared)
            // A timed probe is one attempt; demand gets the retry cycle back.
            repeat(2) { fixture.connector.results.send(Result.failure(java.io.IOException("offline"))) }
            assertTrue(runCatching { lease.reconnect(retry = false) }.isFailure)
            assertTrue(manager.state.value.recoverable)
            assertEquals(3, fixture.connector.resumeCalls)
            fixture.connector.results.send(Result.success(FakeTransport(fixture.credential)))
            lease.reconnect()
            assertEquals(YaConnectionPhase.CONNECTED, manager.state.value.phase)
            assertEquals(5, fixture.connector.resumeCalls)
        } finally { lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun invalidNativeProofIsTerminalAndCannotBeRestartedByDemand() = runBlocking {
        val fixture = Fixture()
        fixture.connector.results.send(Result.failure(uniffi.ya_mobile_core.CoreException.InvalidMessage()))
        val manager = fixture.manager(retryDelaysMs = listOf(0))
        val lease = manager.acquire()
        try {
            val failed = withTimeout(2_000) { manager.state.first { it.phase == YaConnectionPhase.FAILED } }
            assertFalse(failed.recoverable)
            assertTrue(runCatching { lease.reconnect() }.isFailure)
            assertTrue(runCatching { lease.request("GET", "/sessions") }.isFailure)
            assertEquals(1, fixture.connector.resumeCalls)
            assertFalse(fixture.repository.credentialCleared)
        } finally { lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun requestErrorCrossesTheWebBridgeWithoutBecomingHttp() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val lease = manager.acquire()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val emitted = CopyOnWriteArrayList<JSONObject>()
        val web = YaWebTransportSession("document", lease, scope, { emitted += it }) {}
        try {
            web.dispatch(JSONObject().put("handle", "document").put("id", "read").put("method", "request")
                .put("params", JSONObject().put("method", "GET").put("path", "/projects")))
            val request = transport.awaitSent("request")
            transport.incoming.send(JSONObject().put("type", "requestError").put("id", request.getString("id"))
                .put("code", "CONNECTION_UNAVAILABLE"))
            withTimeout(2_000) { while (emitted.none { it.optString("id") == "read" }) delay(1) }
            val reply = emitted.first { it.optString("id") == "read" }
            assertEquals("CONNECTION_UNAVAILABLE", reply.getString("errorCode"))
            assertFalse(reply.has("result"))
            assertEquals(YaConnectionPhase.CONNECTED, manager.state.value.phase)
            assertFalse(transport.cancelled)
        } finally { web.close(); scope.cancel(); manager.shutdownAndAwait() }
    }

    @Test
    fun uploadInterruptedByRecoveryDoesNotCloseWebDocument() = runBlocking {
        val fixture = Fixture()
        val first = FakeTransport(fixture.credential)
        val next = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(first))
        val manager = fixture.manager()
        val lease = manager.acquire()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val emitted = CopyOnWriteArrayList<JSONObject>()
        val web = YaWebTransportSession("document", lease, scope, { emitted += it }) {}
        val uploadId = UUID.randomUUID()
        try {
            web.dispatch(JSONObject().put("handle", "document").put("id", "start").put("method", "uploadStart")
                .put("params", JSONObject().put("type", "staged_upload_start").put("uploadId", uploadId.toString())
                    .put("size", 2).put("filename", "small.bin").put("mimeType", "application/octet-stream")))
            first.awaitSent("staged_upload_start")
            withTimeout(2_000) { while (emitted.none { it.optString("id") == "start" }) delay(1) }
            val recovery = async(start = CoroutineStart.UNDISPATCHED) { lease.reconnect() }
            val chunk = ByteBuffer.allocate(25).putLong(uploadId.mostSignificantBits)
                .putLong(uploadId.leastSignificantBits).putLong(0).put(1.toByte()).array()
            web.uploadChunk(chunk)
            assertTrue(emitted.any { it.optString("type") == "upload_error" && it.optString("uploadId") == uploadId.toString() })
            fixture.connector.results.send(Result.success(next))
            withTimeout(2_000) { recovery.await() }
            web.dispatch(JSONObject().put("handle", "document").put("id", "after").put("method", "request")
                .put("params", JSONObject().put("method", "GET").put("path", "/version")))
            val request = next.awaitSent("request")
            next.incoming.send(JSONObject().put("type", "response").put("id", request.getString("id"))
                .put("status", 200).put("body", JSONObject()))
            withTimeout(2_000) { while (emitted.none { it.optString("id") == "after" }) delay(1) }
            assertTrue(emitted.first { it.optString("id") == "after" }.has("result"))
        } finally { web.close(); scope.cancel(); manager.shutdownAndAwait() }
    }

    @Test
    fun foregroundRecoveryReplacesStaleTransportAndJoinsConcurrentDemand() = runBlocking {
        val fixture = Fixture()
        val first = FakeTransport(fixture.credential)
        val next = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(first))
        val manager = fixture.manager()
        val owner = manager.acquire()
        val sibling = manager.acquire()
        try {
            val subscription = sibling.subscribe("activity")
            val original = first.awaitSent("subscribe")
            val recovery = async(start = CoroutineStart.UNDISPATCHED) { owner.reconnect() }
            val joined = async(start = CoroutineStart.UNDISPATCHED) { sibling.reconnect() }
            assertTrue(first.cancelled)
            assertFalse(recovery.isCompleted)
            fixture.connector.results.send(Result.success(next))
            withTimeout(2_000) { recovery.await(); joined.await() }
            assertEquals(2, fixture.connector.resumeCalls)
            assertEquals(original.getString("subscriptionId"), next.awaitSent("subscribe").getString("subscriptionId"))
            owner.releaseAndAwait()
            assertFalse(next.cancelled)
            subscription.close()
        } finally { owner.releaseAndAwait(); sibling.releaseAndAwait(); manager.shutdownAndAwait() }
        assertTrue(next.cancelled)
    }

    @Test
    fun departingWebDocumentCannotResurrectSubscriptionsOrCloseSiblingLeases() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        val manager = fixture.manager()
        val webLease = manager.acquire()
        val sibling = manager.acquire()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val emitted = CopyOnWriteArrayList<JSONObject>()
        val web = YaWebTransportSession("document-one", webLease, scope, { emitted += it }) {}
        fun command(id: String, method: String) = JSONObject().put("handle", "document-one")
            .put("id", id).put("method", method).put("params", JSONObject()
                .put("subscriptionId", "local-subscription").put("channel", "activity"))
        try {
            assertTrue(runCatching { web.dispatch(command("stale", "subscribe").put("handle", "old-document")) }.isFailure)
            web.dispatch(command("subscribe-before-connect", "subscribe"))
            web.dispatch(command("unsubscribe-before-connect", "unsubscribe"))
            fixture.connector.results.send(Result.success(transport))
            withTimeout(2_000) { manager.state.first { it.phase == YaConnectionPhase.CONNECTED } }
            assertFalse(transport.sent.any { it.optString("type") == "subscribe" })
            web.dispatch(command("subscribe-again", "subscribe"))
            val sent = transport.awaitSent("subscribe")
            assertFalse(sent.getString("subscriptionId") == "local-subscription")
            web.close()
            transport.awaitSent("unsubscribe")
            assertFalse(transport.cancelled)
            val request = async { sibling.request("GET", "/version") }
            val wireRequest = transport.awaitSent("request")
            transport.incoming.send(JSONObject().put("type", "response").put("id", wireRequest.getString("id"))
                .put("status", 200).put("body", JSONObject()))
            assertEquals(200, request.await().status)
            assertTrue(runCatching { web.dispatch(command("departed", "subscribe")) }.isFailure)
        } finally { web.close(); scope.cancel(); sibling.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun streamsUploadsWithLeaseIsolationAndCancelsOnlyTheDepartedConsumer() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val first = manager.acquire()
        val sibling = manager.acquire()
        try {
            val upload = first.startUpload(JSONObject().put("type", "staged_upload_start")
                .put("size", 65537).put("filename", "test.bin").put("mimeType", "application/octet-stream"))
            assertEquals(upload.id, transport.awaitSent("staged_upload_start").getString("uploadId"))
            assertTrue(runCatching { sibling.sendUploadChunk(upload.id, 0, byteArrayOf(1)) }.isFailure)
            first.sendUploadChunk(upload.id, 0, ByteArray(65536))
            assertTrue(runCatching { first.sendUploadChunk(upload.id, 0, byteArrayOf(1)) }.isFailure)
            assertTrue(runCatching { first.endUpload(upload.id) }.isFailure)
            assertEquals(65536, transport.chunks.single().size)
            first.releaseAndAwait()
            assertEquals(upload.id, transport.awaitSent("upload_end").getString("uploadId"))
            assertFalse(transport.cancelled)
            assertTrue(runCatching { first.sendUploadChunk(upload.id, 65536, byteArrayOf(1)) }.isFailure)
        } finally { sibling.releaseAndAwait(); manager.shutdownAndAwait() }
        assertTrue(transport.cancelled)
    }

    @Test
    fun cancellingFullyTransferredUploadEndsServerStateWithoutClosingSibling() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val owner = manager.acquire()
        val sibling = manager.acquire()
        try {
            val upload = owner.startUpload(JSONObject().put("type", "staged_upload_start")
                .put("size", 1).put("filename", "complete.bin").put("mimeType", "application/octet-stream"))
            owner.sendUploadChunk(upload.id, 0, byteArrayOf(1))
            owner.cancelUpload(upload.id)
            assertEquals(upload.id, transport.awaitSent("upload_end").getString("uploadId"))
            assertFalse(transport.cancelled)
            assertTrue(runCatching { owner.endUpload(upload.id) }.isFailure)
        } finally { owner.releaseAndAwait(); sibling.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun supportsFullWebSubscriptionChannelsWithoutSharingLocalIds() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val lease = manager.acquire()
        try {
            lease.subscribe("glossary", projectId = "project-one")
            lease.subscribe("worktree", projectId = "project-one", coverage = JSONObject().put("files", true))
            assertEquals(listOf("glossary", "worktree"), transport.sent.filter { it.getString("type") == "subscribe" }.map { it.getString("channel") })
            assertEquals(2, transport.sent.map { it.getString("subscriptionId") }.toSet().size)
            assertTrue(runCatching { lease.subscribe("worktree", projectId = "project-one") }.isFailure)
        } finally { lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun multiplexesRequestsAndClosesOnlyAfterTheFinalLease() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager()
        val firstLease = manager.acquire()
        val secondLease = manager.acquire()

        val request = async {
            firstLease.request("GET", "/sessions")
        }
        val requestMessage = transport.awaitSent("request")
        transport.incoming.send(
            JSONObject()
                .put("type", "response")
                .put("id", requestMessage.getString("id"))
                .put("status", 200)
                .put("body", JSONObject().put("sessions", 2)),
        )
        val response = request.await()
        assertEquals(200, response.status)
        assertEquals(2, (response.body as JSONObject).getInt("sessions"))

        firstLease.releaseAndAwait()
        assertFalse(transport.cancelled)
        secondLease.releaseAndAwait()
        assertTrue(transport.cancelled)
        assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)
        manager.shutdownAndAwait()
    }

    @Test
    fun restoresSubscriptionsAcrossABoundedReconnect() = runBlocking {
        val fixture = Fixture()
        val firstTransport = FakeTransport(fixture.credential)
        val secondTransport = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(firstTransport))
        fixture.connector.results.send(Result.success(secondTransport))
        val manager = fixture.manager(retryDelaysMs = listOf(0))
        val lease = manager.acquire()
        val subscription = lease.subscribe(channel = "activity")
        val firstSubscribe = firstTransport.awaitSent("subscribe")
        val subscriptionId = firstSubscribe.getString("subscriptionId")
        val firstEvent = async { subscription.events.first() }
        firstTransport.incoming.send(
            JSONObject()
                .put("type", "event")
                .put("subscriptionId", subscriptionId)
                .put("eventType", "session_updated")
                .put("eventId", "4")
                .put("data", JSONObject().put("sessionId", "session-1")),
        )
        assertEquals("4", firstEvent.await().eventId)

        firstTransport.incoming.close(IllegalStateException("network lost"))
        val restored = secondTransport.awaitSent("subscribe")
        assertEquals(subscriptionId, restored.getString("subscriptionId"))
        assertEquals("4", restored.getString("lastEventId"))
        assertEquals(YaConnectionPhase.CONNECTED, manager.state.value.phase)

        subscription.close()
        secondTransport.awaitSent("unsubscribe")
        lease.releaseAndAwait()
        assertTrue(secondTransport.cancelled)
        manager.shutdownAndAwait()
    }

    @Test
    fun conversationBindingsCloseOnDisconnectWhileActivityReplays() = runBlocking {
        val fixture = Fixture()
        val first = FakeTransport(fixture.credential)
        val second = FakeTransport(fixture.credential)
        fixture.connector.results.send(Result.success(first))
        fixture.connector.results.send(Result.success(second))
        val manager = fixture.manager(retryDelaysMs = listOf(0))
        val lease = manager.acquire()
        try {
            lease.subscribe(channel = "activity")
            val conversation = lease.subscribeConversation("binding-one", ConversationQuery("session", 20, null))
            val frame = first.sent.first { it.optString("subscriptionId") == "binding-one" }
            assertEquals("/api/experimental/conversation/subscribe", frame.getString("channel"))
            assertEquals(CONVERSATION_API_REVISION, frame.getString("apiRevision"))
            assertEquals(20, frame.getJSONObject("query").getInt("maxMessages"))
            val closed = async { runCatching { conversation.events.first() }.exceptionOrNull() }
            first.incoming.close(IllegalStateException("Disconnected"))
            val restored = second.awaitSent("subscribe")
            assertEquals("activity", restored.getString("channel"))
            assertNotNull(withTimeout(2000) { closed.await() })
            assertFalse(second.sent.any { it.optString("subscriptionId") == "binding-one" })
            val fresh = lease.subscribeConversation("binding-two", ConversationQuery("session", 40, "anchor"))
            val event = async { fresh.events.first() }
            second.incoming.send(JSONObject().put("type", "event").put("subscriptionId", "binding-two")
                .put("eventType", "snapshot").put("data", JSONObject().put("sequence", 0)))
            assertEquals(0, (withTimeout(2000) { event.await() }.data as JSONObject).getInt("sequence"))
        } finally { lease.releaseAndAwait(); manager.shutdownAndAwait() }
    }

    @Test
    fun clearsARejectedCredentialAndRequiresVisibleReauthentication() = runBlocking {
        val fixture = Fixture()
        fixture.connector.results.send(Result.failure(YaAllRoutesRejectedException()))
        val manager = fixture.manager(retryDelaysMs = emptyList())
        val lease = manager.acquire()

        val error = runCatching { lease.request("GET", "/sessions") }.exceptionOrNull()
        assertNotNull(error)
        assertEquals(YaConnectionPhase.REAUTHENTICATION_REQUIRED, manager.state.value.phase)
        assertTrue(fixture.repository.credentialCleared)
        assertEquals(1, fixture.connector.resumeCalls)

        lease.releaseAndAwait()
        manager.shutdownAndAwait()
    }

    @Test
    fun exposesRevocationAsADistinctTerminalConnectionState() = runBlocking {
        val fixture = Fixture()
        val transport = FakeTransport(fixture.credential)
        val emitRevocation = CompletableDeferred<Unit>()
        fixture.connector.results.send(Result.success(transport))
        val manager = fixture.manager(
            securityClients = YaSecurityClientLifecycle { _, activeTransport ->
                assertTrue(activeTransport === transport)
                emitRevocation.await()
                throw YaSecurityClientRevokedException(
                    "44444444-4444-4444-8444-444444444444",
                )
            },
        )
        val lease = manager.acquire()

        val request = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { lease.request("GET", "/sessions") }
        }
        emitRevocation.complete(Unit)
        val error = request.await().exceptionOrNull()

        assertNotNull(error)
        assertEquals(YaConnectionPhase.REVOKED, manager.state.value.phase)
        transport.awaitCancelled()
        assertTrue(transport.cancelled)
        lease.releaseAndAwait()
        manager.shutdownAndAwait()
    }

    @Test
    fun releasingTheFinalLeaseCancelsAnOwnedRetryDelay() = runBlocking {
        val fixture = Fixture()
        fixture.connector.results.send(Result.failure(IllegalStateException("offline")))
        val manager = fixture.manager(retryDelaysMs = listOf(60_000))
        val lease = manager.acquire()
        withTimeout(2_000) {
            manager.state.first { it.phase == YaConnectionPhase.RETRYING }
        }
        val callsBeforeRelease = fixture.connector.resumeCalls

        lease.releaseAndAwait()
        delay(20)
        assertEquals(callsBeforeRelease, fixture.connector.resumeCalls)
        assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)
        manager.shutdownAndAwait()
    }

    @Test
    fun triesThePreferredDirectRouteBeforeLegacyRelayFallback() = runBlocking {
        val fixture = Fixture()
        val relayRoute = YaServerRoute.relay(
            "wss://relay.example.test/ws",
            "remote-target",
        )
        val profile = fixture.profile.copy(routes = listOf(fixture.route, relayRoute))
        val relayTransport = FakeTransport(fixture.credential)
        val opener = FakeSessionOpener(
            mapOf(
                fixture.route.websocketUrl to Result.failure(IllegalStateException("offline")),
                relayRoute.websocketUrl to Result.success(relayTransport),
            ),
        )

        val connected = YaNativeProfileConnector(opener).resume(profile, fixture.credential)

        assertEquals(relayRoute, connected.route)
        assertEquals(
            listOf(
                fixture.route.websocketUrl to null,
                relayRoute.websocketUrl to "remote-target",
            ),
            opener.attempts,
        )
    }

    @Test
    fun doesNotTurnCoroutineCancellationIntoRouteFallback() = runBlocking {
        val fixture = Fixture()
        val relayRoute = YaServerRoute.relay(
            "wss://relay.example.test/ws",
            "remote-target",
        )
        val profile = fixture.profile.copy(routes = listOf(fixture.route, relayRoute))
        val opener = FakeSessionOpener(
            mapOf(fixture.route.websocketUrl to Result.failure(CancellationException("owner left"))),
        )

        val error = runCatching {
            YaNativeProfileConnector(opener).resume(profile, fixture.credential)
        }.exceptionOrNull()

        assertTrue(error is CancellationException)
        assertEquals(listOf(fixture.route.websocketUrl to null), opener.attempts)
    }

    private class Fixture {
        val route = YaServerRoute.direct("wss://desktop.example.test/api/ws")
        val profile = YaPairedServerProfile.create(
            label = "Studio",
            username = "remote-user",
            route = route,
            nowEpochMs = NOW,
        )
        val credential = YaResumeCredential(
            username = profile.username,
            sessionId = "resume-session",
            baseKey = ByteArray(YaSecureTransportCrypto.KEY_BYTES) { it.toByte() },
            resumeProtocolVersion = YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION,
        )
        val repository = FakeRepository(
            YaPairedServerSnapshot(
                profile,
                YaStoredResumeCredential(credential, NOW, null),
            ),
        )
        val connector = FakeConnector(route)

        fun manager(
            retryDelaysMs: List<Long> = emptyList(),
            securityClients: YaSecurityClientLifecycle? = null,
        ): YaServerConnectionManager {
            return YaServerConnectionManager(
                profileId = profile.id,
                repository = repository,
                connector = connector,
                securityClients = securityClients,
                dispatcher = Dispatchers.Default,
                nowEpochMs = { NOW + 1_000 },
                retryDelaysMs = retryDelaysMs,
            )
        }
    }

    private class FakeRepository(
        private var storedSnapshot: YaPairedServerSnapshot,
    ) : YaPairedServerRepository {
        var credentialCleared = false

        override suspend fun snapshot(profileId: String): YaPairedServerSnapshot? {
            return storedSnapshot.takeIf { it.profile.id == profileId }
        }

        override suspend fun upsert(
            profile: YaPairedServerProfile,
            resumeCredential: YaStoredResumeCredential?,
            select: Boolean,
        ) {
            storedSnapshot = YaPairedServerSnapshot(profile, resumeCredential)
        }

        override suspend fun clearCredential(profileId: String) {
            credentialCleared = true
            storedSnapshot = storedSnapshot.copy(resumeCredential = null)
        }

        override suspend fun recordSuccessfulAuthentication(
            profileId: String,
            routeId: String,
            resumeCredential: YaStoredResumeCredential,
            connectedAtEpochMs: Long,
        ) {
            storedSnapshot = storedSnapshot.copy(
                profile = storedSnapshot.profile.copy(
                    preferredRouteId = routeId,
                    lastConnectedAtEpochMs = connectedAtEpochMs,
                ),
                resumeCredential = resumeCredential,
            )
        }
    }

    private class FakeConnector(
        private val route: YaServerRoute,
    ) : YaProfileConnector {
        val results = Channel<Result<YaMessageTransport>>(Channel.UNLIMITED)
        var resumeCalls = 0

        override suspend fun resume(
            profile: YaPairedServerProfile,
            credential: YaResumeCredential,
        ): YaRoutedTransport {
            resumeCalls += 1
            return YaRoutedTransport(route, results.receive().getOrThrow())
        }

        override suspend fun login(
            route: YaServerRoute,
            username: String,
            password: String,
        ): YaMessageTransport {
            error("Not used")
        }
    }

    private class FakeSessionOpener(
        private val resumeResults: Map<String, Result<YaMessageTransport>>,
    ) : YaSecureSessionOpener {
        val attempts = mutableListOf<Pair<String, String?>>()

        override suspend fun login(
            wsUrl: String,
            username: String,
            password: String,
            relayTarget: String?,
        ): YaMessageTransport {
            error("Not used")
        }

        override suspend fun resume(
            wsUrl: String,
            credential: YaResumeCredential,
            relayTarget: String?,
        ): YaMessageTransport {
            attempts += wsUrl to relayTarget
            return checkNotNull(resumeResults[wsUrl]).getOrThrow()
        }
    }

    private class FakeTransport(
        override val credential: YaResumeCredential,
    ) : YaMessageTransport {
        override val resumed = true
        val incoming = Channel<JSONObject>(Channel.UNLIMITED)
        val sent = CopyOnWriteArrayList<JSONObject>()
        val chunks = CopyOnWriteArrayList<ByteArray>()
        var cancelled = false
        val receiveStarted = CompletableDeferred<Unit>()
        var body: YaResponseBody? = null
        var bodyParams: JSONObject? = null
        var bodyGate: (suspend () -> YaResponseBody)? = null
        override suspend fun fetchResponse(params: JSONObject): YaResponseBody? {
            bodyParams = params
            return bodyGate?.invoke() ?: body
        }
        private val cancelledSignal = CompletableDeferred<Unit>()

        override fun send(message: JSONObject) {
            check(!cancelled)
            sent += JSONObject(message.toString())
        }

        override suspend fun sendUploadChunk(uploadId: String, offset: Long, chunk: ByteArray) {
            check(!cancelled)
            chunks += chunk
        }

        override suspend fun receive(): JSONObject { receiveStarted.complete(Unit); return incoming.receive() }

        override suspend fun awaitClosed() {
            for (ignored in incoming) Unit
        }

        override suspend fun closeAndAwait() {
            cancel()
        }

        override fun cancel() {
            cancelled = true
            cancelledSignal.complete(Unit)
            incoming.close()
        }

        suspend fun awaitCancelled() {
            withTimeout(2_000) { cancelledSignal.await() }
        }

        suspend fun awaitSent(type: String): JSONObject {
            return withTimeout(2_000) {
                var message = sent.firstOrNull { it.getString("type") == type }
                while (message == null) {
                    delay(1)
                    message = sent.firstOrNull { it.getString("type") == type }
                }
                message
            }
        }
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
    }
}
