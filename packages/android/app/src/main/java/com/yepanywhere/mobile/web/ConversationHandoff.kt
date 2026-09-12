package com.yepanywhere.mobile.web

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRouteKind
import java.net.URI
import java.net.URLEncoder

data class ConversationHandoff(val url: String, val inWebClient: Boolean)

/** Never open another profile's ambient web session or transfer native keys. */
fun conversationHandoff(profile: YaPairedServerProfile, projectId: String, sessionId: String,
    clientStartUrl: String): ConversationHandoff? {
    if (projectId.isBlank() || sessionId.isBlank()) return null
    fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    val route = profile.routes.firstOrNull { it.id == profile.preferredRouteId } ?: profile.routes.first()
    val suffix = "/projects/${encode(projectId)}/sessions/${encode(sessionId)}"
    return if (route.kind == YaServerRouteKind.RELAY) {
        val target = "/-/relay/${encode(checkNotNull(route.relayTarget))}$suffix"
        ConversationHandoff(clientStartUrl.trimEnd('/') + "/login/relay?u=${encode(route.relayTarget)}" +
            "&r=${encode(route.websocketUrl)}&returnTo=${encode(target)}", true)
    } else {
        val uri = URI(route.websocketUrl)
        if (!uri.path.matches(Regex(".*/api/ws/?"))) return null
        val base = uri.rawPath.replace(Regex("/api/ws/?$"), "")
        ConversationHandoff("${if (uri.scheme == "wss") "https" else "http"}://${uri.rawAuthority}$base$suffix", false)
    }
}
