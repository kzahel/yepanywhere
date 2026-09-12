package com.yepanywhere.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.net.toUri
import com.yepanywhere.mobile.ui.YaConversationScreen
import com.yepanywhere.mobile.ui.YaConversationViewModel
import com.yepanywhere.mobile.ui.theme.YepAnywhereTheme
import com.yepanywhere.mobile.web.WebClientActivity

class YaConversationActivity : ComponentActivity() {
    private val viewModel by viewModels<YaConversationViewModel>()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            YepAnywhereTheme {
                YaConversationScreen(viewModel, onBack = { finish() }, onOpenFull = {
                    val destination = viewModel.handoff.value ?: return@YaConversationScreen
                    val target = if (destination.inWebClient) Intent(this, WebClientActivity::class.java)
                        else Intent(Intent.ACTION_VIEW)
                    startActivity(target.setData(destination.url.toUri()))
                })
            }
        }
    }
    override fun onStart() {
        super.onStart()
        viewModel.presenter.setVisible(true)
    }
    override fun onStop() {
        viewModel.presenter.setVisible(false)
        super.onStop()
    }
}
