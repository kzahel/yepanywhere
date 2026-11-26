package com.yepanywhere.mobile.ui

internal sealed interface YaShellDestination {
    data object Tabs : YaShellDestination
    data object OtherHost : YaShellDestination
    data object SwitchHost : YaShellDestination
    data class Hosts(val fromSwitcher: Boolean = false) : YaShellDestination
    data class Details(val profileId: String, val returnTo: YaShellDestination, val newTab: Boolean = false) : YaShellDestination
    data class AddHost(val returnTo: YaShellDestination?) : YaShellDestination

    val isSheet: Boolean get() = this == Tabs || this == OtherHost || this == SwitchHost
}
