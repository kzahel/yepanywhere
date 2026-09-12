package com.yepanywhere.mobile.web

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRoute
import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.*
import org.junit.Test

class ConversationHandoffTest {
    @Test fun directHandoffPreservesDeploymentAndEscapesPathSegments() {
        val profile = profile(YaServerRoute.direct("wss://studio.test/ya/api/ws"))
        val result = conversationHandoff(profile, "project space", "session/id", "https://client.test/")!!
        assertFalse(result.inWebClient)
        assertEquals("https://studio.test/ya/projects/project%20space/sessions/session%2Fid", result.url)
        assertNull(conversationHandoff(profile, "", "s", "https://client.test/"))
        assertNull(conversationHandoff(profile(YaServerRoute.direct("wss://studio.test/custom")), "p", "s", "https://client.test/"))
    }

    @Test fun relayHandoffCarriesTheSelectedCustomRelayAndSession() {
        val relay = YaServerRoute.relay("wss://private-relay.test/socket", "studio-user")
        val other = YaServerRoute.direct("wss://other.test/api/ws")
        val profile = profile(relay).copy(routes = listOf(other, relay))
        val result = conversationHandoff(profile, "p", "s", "https://client.test/")!!
        assertTrue(result.inWebClient)
        val uri = URI(result.url)
        val query = uri.rawQuery.split("&").associate { val parts = it.split("=", limit = 2); parts[0] to URLDecoder.decode(parts[1], "UTF-8") }
        assertEquals("/login/relay", uri.path)
        assertEquals("studio-user", query["u"])
        assertEquals(relay.websocketUrl, query["r"])
        assertEquals("/-/relay/studio-user/projects/p/sessions/s", query["returnTo"])
    }

    private fun profile(route: YaServerRoute) = YaPairedServerProfile.create("Studio", "studio-user", route)
}
