package __APP_PACKAGE__

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.rgb(10, 12, 19))
    )
    super.onCreate(savedInstanceState)
  }

  override fun setContentView(view: View?) {
    if (view == null) {
      super.setContentView(view)
      return
    }
    // WebView 的 safe-area-inset 在部分 Android 版本上为零。原生容器先避开
    // 状态栏、刘海、导航栏和键盘，让页面与全屏预览始终位于可用区域。
    val content = FrameLayout(this).apply {
      setBackgroundColor(Color.rgb(10, 12, 19))
      addView(view, FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      ))
    }
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      content.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      // 已在容器消耗的间距不再传给 WebView，避免 CSS safe-area 重复留白。
      WindowInsetsCompat.CONSUMED
    }
    super.setContentView(content)
    ViewCompat.requestApplyInsets(content)
  }
}
