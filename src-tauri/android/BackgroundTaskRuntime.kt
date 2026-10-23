package app.imagestudio.background

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference

/** 只保留进程内任务，不在重启后擅自重放付费请求。所有 WebView 操作在主线程执行。 */
object BackgroundTaskRuntime {
  @Volatile var activeTasks = 0
    private set
  @Volatile var wakeLockHeld = false
    private set
  @Volatile var lastError: String? = null
    private set
  private val main = Handler(Looper.getMainLooper())
  private var webView = WeakReference<WebView>(null)
  private var paused = false
  private var rendererPolicy: Pair<Int, Boolean>? = null

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post { action() }
  }

  fun attach(view: WebView) {
    onMain {
      if (view !== webView.get()) {
        webView.get()?.let { restoreRendererPolicy(it) }
        webView = WeakReference(view)
        rendererPolicy = if (Build.VERSION.SDK_INT >= 26) runCatching {
          Pair(view.rendererRequestedPriority, view.rendererPriorityWaivedWhenNotVisible)
        }.getOrNull() else null
      }
      applyScheduling()
    }
  }

  fun setPaused(value: Boolean) {
    onMain {
      paused = value
      // Tauri 的插件回调在 WryActivity.onPause 暂停 WebView 之后执行。
      applyScheduling()
    }
  }

  fun update(count: Int, held: Boolean, clearError: Boolean = false) {
    activeTasks = count
    wakeLockHeld = held
    if (clearError) lastError = null
    applyScheduling()
  }

  fun interrupted(reason: String) {
    activeTasks = 0
    wakeLockHeld = false
    lastError = reason
    onMain {
      val view = webView.get()
      if (view == null) return@onMain
      // 先恢复 JS 派发停止事件，再恢复空闲调度；不能在派发之前暂停 WebView。
      runCatching {
        view.onResume()
        view.resumeTimers()
        val script = "window.dispatchEvent(new CustomEvent('image-studio-background-error',{detail:${JSONObject.quote(reason)}}))"
        view.evaluateJavascript(script) { applyScheduling() }
      }.onFailure { applyScheduling() }
      // 渲染进程已退出时回调可能不来，仍须恢复原本的节电策略。
      main.postDelayed({ applyScheduling() }, 1_000L)
    }
  }

  fun detach() {
    onMain {
      webView.get()?.let { restoreRendererPolicy(it) }
      webView.clear()
      rendererPolicy = null
      paused = false
    }
  }

  private fun restoreRendererPolicy(view: WebView) {
    val policy = rendererPolicy ?: return
    if (Build.VERSION.SDK_INT >= 26) runCatching { view.setRendererPriorityPolicy(policy.first, policy.second) }
  }

  private fun applyScheduling() {
    onMain {
      val view = webView.get() ?: return@onMain
      runCatching {
        val running = activeTasks > 0
        if (Build.VERSION.SDK_INT >= 26) {
          // 运行时提高隐藏渲染进程优先级；空闲时恢复该 WebView 实际原策略，不能臆造默认值。
          if (running) view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
          else restoreRendererPolicy(view)
        }
        if (running || !paused) {
          view.onResume()
          if (running) view.resumeTimers()
        } else {
          view.onPause()
        }
      }
    }
  }
}
