package app.imagestudio.background

import android.os.Build
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.io.File

/** 只保留进程内任务，不在重启后擅自重放付费请求。所有 WebView 操作在主线程执行。 */
object BackgroundTaskRuntime {
  @Volatile var activeTasks = 0
    private set
  @Volatile var wakeLockHeld = false
    private set
  @Volatile var lastError: String? = null
    private set
  @Volatile var networkAvailable = false
    private set
  @Volatile var networkBlocked = false
    private set
  private var connectivity: ConnectivityManager? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private val main = Handler(Looper.getMainLooper())
  private var webView = WeakReference<WebView>(null)
  private var paused = false
  private var rendererPolicy: Pair<Int, Boolean>? = null

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post { action() }
  }

  @Synchronized fun trace(context: Context, event: String) {
    runCatching {
      val screenOn = context.getSystemService(PowerManager::class.java).isInteractive
      val line = "${System.currentTimeMillis()} $event active=$activeTasks wake=$wakeLockHeld screenOn=$screenOn network=$networkAvailable blocked=$networkBlocked"
      Log.i("ImageStudioTasks", line)
      // 断开 ADB 后 logcat 可能很快被系统滚动覆盖；私有目录保留有界的状态日志。
      // 只记录调度和网络状态，不记录提示词、图片、地址或密钥。
      val file = File(context.filesDir, "background-task.log")
      if (file.length() > 128 * 1024) file.writeText("")
      file.appendText("$line\n")
    }
  }

  fun attach(view: WebView) {
    onMain {
      monitorNetwork(view.context.applicationContext)
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

  private fun monitorNetwork(context: Context) {
    if (networkCallback != null) return
    val manager = context.getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
      private var current: Network? = null
      private var usable = false
      private var blocked: Boolean? = null
      private fun publish() {
        val isBlocked = blocked == true
        val available = usable && blocked == false
        onMain {
          // 注销后的迟到回调不能覆盖新 WebView 的网络状态。
          if (networkCallback !== this) return@onMain
          val changed = networkBlocked != isBlocked || networkAvailable != available
          networkBlocked = isBlocked
          networkAvailable = available
          if (changed) trace(context, "network")
        }
      }
      override fun onAvailable(network: Network) {
        current = network
        usable = false
        blocked = if (Build.VERSION.SDK_INT >= 29) null else false
        publish()
      }
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        if (current != network) return
        // 不要求 VALIDATED：局域网网关可能可用但没有外网验证。
        usable = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          (Build.VERSION.SDK_INT < 28 || capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED))
        publish()
      }
      override fun onBlockedStatusChanged(network: Network, value: Boolean) {
        if (current != network) return
        blocked = value
        publish()
      }
      override fun onLost(network: Network) {
        if (current != network) return
        current = null
        usable = false
        blocked = null
        publish()
      }
    }
    try {
      manager.registerDefaultNetworkCallback(callback)
      connectivity = manager
      networkCallback = callback
    } catch (error: Exception) {
      lastError = "Android 无法监测联网状态：${error.message ?: "系统拒绝"}"
    }
  }

  fun setPaused(value: Boolean) {
    onMain {
      paused = value
      webView.get()?.let { trace(it.context, if (value) "pause" else "resume") }
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
      networkCallback?.let { runCatching { connectivity?.unregisterNetworkCallback(it) } }
      networkCallback = null
      connectivity = null
      networkAvailable = false
      networkBlocked = false
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
