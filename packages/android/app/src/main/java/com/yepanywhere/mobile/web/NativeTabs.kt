package com.yepanywhere.mobile.web

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Persistent navigation metadata only. No credentials, WebViews or source leases. */
class NativeTabs {
    data class Tab(val id: String, val profileId: String, var path: String = "/projects", var title: String = "Projects")
    val items = mutableListOf<Tab>()
    var selectedId: String? = null
        private set
    private val lastSelectedByProfile = mutableMapOf<String, String>()
    val selected: Tab? get() = items.firstOrNull { it.id == selectedId }

    fun open(profileId: String, path: String = "/projects", newTab: Boolean = false, foreground: Boolean = true): Tab? {
        val existing = if (newTab) null else (items.firstOrNull { it.id == lastSelectedByProfile[profileId] } ?: items.firstOrNull { it.profileId == profileId })
        val tab = existing ?: run {
            if (items.size >= MAX_TABS) return null
            Tab(UUID.randomUUID().toString(), profileId, livePath(path)).also(items::add)
        }
        if (foreground || selected == null) select(tab.id)
        return tab
    }
    fun select(id: String) {
        val tab = items.firstOrNull { it.id == id } ?: return
        selectedId = tab.id
        lastSelectedByProfile[tab.profileId] = tab.id
    }
    fun close(id: String) {
        val index = items.indexOfFirst { it.id == id }
        if (index < 0) return
        val closed = items.removeAt(index)
        if (lastSelectedByProfile[closed.profileId] == id) lastSelectedByProfile.remove(closed.profileId)
        if (selectedId == id) {
            selectedId = null
            items.getOrNull(index.coerceAtMost(items.lastIndex))?.let { select(it.id) }
        }
    }
    fun retainProfiles(ids: Set<String>) { items.filter { it.profileId !in ids }.map { it.id }.forEach(::close) }
    fun encode(): String = JSONObject().put("selected", selectedId)
        .put("lastSelectedByProfile", JSONObject().apply { lastSelectedByProfile.forEach { (profile, id) -> put(profile, id) } }).put("tabs", JSONArray().apply {
        items.forEach { put(JSONObject().put("id", it.id).put("profile", it.profileId).put("path", safePath(it.path))) }
    }).toString()
    fun restore(encoded: String?) {
        items.clear()
        lastSelectedByProfile.clear()
        selectedId = null
        runCatching {
            val value = JSONObject(encoded ?: return)
            val tabs = value.getJSONArray("tabs")
            for (index in 0 until minOf(tabs.length(), MAX_TABS)) {
                val tab = tabs.getJSONObject(index)
                val id = tab.getString("id")
                val profile = tab.getString("profile")
                if (id.length !in 1..128 || profile.length !in 1..128 || items.any { it.id == id }) continue
                items.add(Tab(id, profile, safePath(tab.optString("path"))))
            }
            val lastSelected = value.optJSONObject("lastSelectedByProfile")
            items.forEach { tab ->
                if (lastSelected?.optString(tab.profileId) == tab.id) lastSelectedByProfile[tab.profileId] = tab.id
            }
            val initial = items.firstOrNull { it.id == value.optString("selected") } ?: items.firstOrNull()
            initial?.let { select(it.id) }
        }.onFailure { items.clear(); lastSelectedByProfile.clear(); selectedId = null }
    }
    companion object {
        const val MAX_TABS = 32

        // Same trailing window-state marker as the web client's composerBeacon.
        private val composerBeacon = Regex(
            """ (?:[↥◷✓!] )?\[YA1 f=\d+ r=\d+ a=\d+ s=(?:idle|sending|queued|delivered|error)\](?: w=[01])?$""",
        )

        fun displayTitle(title: String?): String =
            title.orEmpty().replace(composerBeacon, "").take(160).ifBlank { "Projects" }

        fun livePath(path: String): String {
            val bare = path.substringBefore('?').substringBefore('#')
            return if (safePath(bare) == bare && path.length <= 8192 && !path.any { it.code < 32 }) path else "/projects"
        }
        fun safePath(path: String): String = path.substringBefore('?').substringBefore('#').takeIf {
            it.startsWith('/') && !it.startsWith("//") && !it.contains('\\') && it.length <= 8192 &&
                !it.any { char -> char.code < 32 } && !it.startsWith("/login") && !it.startsWith("/open")
        } ?: "/projects"
    }
}
