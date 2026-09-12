package com.yepanywhere.mobile.ui

import org.json.JSONArray
import org.json.JSONObject

data class YaSessionSummary(
    val id: String,
    val title: String?,
    val projectName: String,
    val provider: String,
    val updatedAt: String,
    val pendingInputType: String?,
    val activity: String?,
    val hasUnread: Boolean,
    val lastAgentText: String?,
    val projectId: String = "",
) {
    companion object {
        fun parseResponse(body: Any?): List<YaSessionSummary> {
            val root = body as? JSONObject
                ?: throw IllegalArgumentException("Session response must be an object")
            val sessions = root.optJSONArray("sessions")
                ?: throw IllegalArgumentException("Session response must include sessions")
            return sessions.mapObjects { item ->
                YaSessionSummary(
                    id = item.requiredString("id"),
                    title = item.firstNonBlankString(
                        "customTitle",
                        "title",
                        "fullTitle",
                        "initialPrompt",
                    ),
                    projectName = item.requiredString("projectName"),
                    provider = item.requiredString("provider"),
                    updatedAt = item.requiredString("updatedAt"),
                    pendingInputType = item.optionalString("pendingInputType"),
                    activity = item.optionalString("activity"),
                    hasUnread = item.optBoolean("hasUnread", false),
                    lastAgentText = item.optionalString("lastAgentText"),
                    projectId = item.optionalString("projectId") ?: "",
                )
            }
        }
    }
}

private fun JSONArray.mapObjects(transform: (JSONObject) -> YaSessionSummary): List<YaSessionSummary> {
    return buildList(length()) {
        repeat(length()) { index ->
            add(transform(getJSONObject(index)))
        }
    }
}

private fun JSONObject.requiredString(name: String): String {
    return optionalString(name)
        ?: throw IllegalArgumentException("Session response has an invalid $name")
}

private fun JSONObject.optionalString(name: String): String? {
    if (isNull(name)) return null
    return optString(name).trim().takeIf(String::isNotEmpty)
}

private fun JSONObject.firstNonBlankString(vararg names: String): String? {
    return names.firstNotNullOfOrNull(::optionalString)
}
