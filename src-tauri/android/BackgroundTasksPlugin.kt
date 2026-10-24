package app.imagestudio.background

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.view.ViewGroup
import androidx.core.view.WindowInsetsControllerCompat
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Environment
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.atomic.AtomicBoolean
import android.media.MediaScannerConnection
import android.provider.MediaStore
import android.util.Base64
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID
import kotlin.concurrent.thread

@InvokeArg
class TaskArgs {
  lateinit var taskId: String
}

@InvokeArg
class AlbumArgs {
  lateinit var dataUrl: String
  lateinit var fileName: String
}

@InvokeArg
class ThemeArgs {
  lateinit var theme: String
  lateinit var mode: String
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "legacyAlbum")])
class BackgroundTasksPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    fun resolvedTheme(activity: Activity): String {
      val saved = activity.getSharedPreferences("image-studio-ui", Activity.MODE_PRIVATE).getString("mode", "system")
      if (saved == "light" || saved == "dark") return saved
      return if ((activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
    }

    fun backgroundColor(activity: Activity): Int =
      if (resolvedTheme(activity) == "light") Color.rgb(246, 250, 248) else Color.rgb(10, 12, 19)

    @Suppress("DEPRECATION")
    fun applyTheme(activity: Activity, theme: String) {
      val light = theme == "light"
      val color = if (light) Color.rgb(246, 250, 248) else Color.rgb(10, 12, 19)
      val window = activity.window
      WindowInsetsControllerCompat(window, window.decorView).apply {
        isAppearanceLightStatusBars = light
        isAppearanceLightNavigationBars = light
      }
      window.navigationBarColor = color
      window.decorView.setBackgroundColor(color)
      val content = activity.findViewById<ViewGroup>(android.R.id.content)
      content?.setBackgroundColor(color)
      content?.getChildAt(0)?.setBackgroundColor(color)
    }
  }

  override fun load(webView: WebView) {
    BackgroundTaskRuntime.attach(webView)
  }

  override fun onPause(activity: AppCompatActivity) {
    BackgroundTaskRuntime.setPaused(true)
  }

  override fun onResume(activity: AppCompatActivity) {
    BackgroundTaskRuntime.setPaused(false)
  }

  override fun onDestroy(activity: AppCompatActivity) {
    // WebView 被销毁后 JS 工作流无法继续；释放保护，不自动重放付费请求。
    BackgroundTaskRuntime.detach()
    runCatching { activity.stopService(Intent(activity, BackgroundTasksService::class.java)) }
  }

  @Command
  fun setTheme(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ThemeArgs::class.java)
      val theme = args.theme
      require(theme == "light" || theme == "dark") { "不支持的主题" }
      require(args.mode in listOf("light", "dark", "system")) { "不支持的主题模式" }
      activity.runOnUiThread {
        activity.getSharedPreferences("image-studio-ui", Activity.MODE_PRIVATE).edit().putString("mode", args.mode).apply()
        applyTheme(activity, theme)
        invoke.resolve()
      }
    } catch (error: Exception) { invoke.reject(error.message ?: "主题切换失败") }
  }

  @Command
  fun saveToAlbum(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < 29 && getPermissionState("legacyAlbum") != PermissionState.GRANTED) {
      requestPermissionForAlias("legacyAlbum", invoke, "albumPermission")
      return
    }
    writeAlbum(invoke)
  }

  @PermissionCallback
  fun albumPermission(invoke: Invoke) {
    if (getPermissionState("legacyAlbum") != PermissionState.GRANTED) {
      invoke.reject("请允许存储权限以保存到相册，或使用另存为")
      return
    }
    writeAlbum(invoke)
  }

  private fun writeAlbum(invoke: Invoke) {
    // 图片解码和磁盘写入放到工作线程，避免相册保存阻塞 WebView。
    thread(name = "image-studio-album") {
      var pendingUri: Uri? = null
      var legacyFile: File? = null
      try {
        val args = invoke.parseArgs(AlbumArgs::class.java)
        val split = args.dataUrl.indexOf(',')
        require(split > 0 && args.dataUrl.startsWith("data:image/") && args.dataUrl.substring(0, split).contains(";base64")) { "图片数据格式无效" }
        val mime = args.dataUrl.substring(5, split).substringBefore(';').lowercase()
        val extension = when (mime) { "image/png" -> "png"; "image/jpeg", "image/jpg" -> "jpg"; "image/webp" -> "webp"; "image/gif" -> "gif"; else -> throw IllegalArgumentException("不支持的图片格式") }
        require(args.dataUrl.length <= 72 * 1024 * 1024) { "图片过大，无法保存到相册" }
        val bytes = Base64.decode(args.dataUrl.substring(split + 1), Base64.DEFAULT)
        require(bytes.isNotEmpty()) { "图片内容为空" }
        val stem = args.fileName.substringAfterLast('/').substringAfterLast('\\').substringBeforeLast('.', "image")
          .replace(Regex("[^A-Za-z0-9_\\-\\u4e00-\\u9fff]"), "_").take(80).ifBlank { "image" }
        val name = "$stem-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}.$extension"
        val resolver = activity.contentResolver
        if (Build.VERSION.SDK_INT >= 29) {
          val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, if (mime == "image/jpg") "image/jpeg" else mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Image Studio")
            put(MediaStore.Images.Media.IS_PENDING, 1)
          }
          val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("无法创建相册图片")
          pendingUri = uri
          resolver.openOutputStream(uri, "w")?.use { it.write(bytes) } ?: throw IllegalStateException("无法写入相册图片")
          values.clear(); values.put(MediaStore.Images.Media.IS_PENDING, 0)
          check(resolver.update(uri, values, null, null) == 1) { "无法完成相册图片保存" }
          pendingUri = null
          val result = JSObject(); result.put("target", uri.toString()); invoke.resolve(result)
        } else {
          @Suppress("DEPRECATION")
          val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Image Studio")
          check(directory.isDirectory || directory.mkdirs()) { "无法创建相册目录" }
          val file = File(directory, name)
          legacyFile = file
          file.outputStream().use { it.write(bytes) }
          MediaScannerConnection.scanFile(activity, arrayOf(file.absolutePath), arrayOf(mime)) { _, uri ->
            val result = JSObject(); result.put("target", uri?.toString() ?: file.absolutePath); invoke.resolve(result)
          }
          legacyFile = null
        }
      } catch (error: Exception) {
        pendingUri?.let { runCatching { activity.contentResolver.delete(it, null, null) } }
        legacyFile?.let { runCatching { it.delete() } }
        invoke.reject(error.message ?: "相册保存失败")
      }
    }
  }

  @Command
  fun start(invoke: Invoke) {
    val handler = Handler(Looper.getMainLooper())
    val settled = AtomicBoolean(false)
    val args = try { invoke.parseArgs(TaskArgs::class.java) } catch (error: Exception) {
      invoke.reject(error.message ?: "无效的后台任务"); return
    }
    if (args.taskId.isBlank()) { invoke.reject("无效的后台任务"); return }
    fun finishOrphan() {
      runCatching { activity.startService(Intent(activity, BackgroundTasksService::class.java)
        .setAction(BackgroundTasksService.FINISH).putExtra("taskId", args.taskId)) }
    }
    val timeout = Runnable {
      if (settled.compareAndSet(false, true)) {
        // 超时不能只 reject 后留一个孤立任务/唤醒锁。
        finishOrphan()
        invoke.reject("Android 后台服务未确认启动，请保持应用前台并检查后台权限")
      }
    }
    val receiver = object : ResultReceiver(handler) {
      override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
        if (!settled.compareAndSet(false, true)) {
          // 超时后的成功确认也要清理，避免迟到 START 又留下孤立任务。
          if (resultCode == 0) finishOrphan()
          return
        }
        handler.removeCallbacks(timeout)
        if (resultCode == 0) invoke.resolve()
        else invoke.reject(resultData?.getString("error") ?: "无法启动后台任务")
      }
    }
    try {
      val intent = Intent(activity, BackgroundTasksService::class.java)
        .setAction(BackgroundTasksService.START)
        .putExtra("taskId", args.taskId)
        .putExtra(BackgroundTasksService.RESULT, receiver)
      handler.postDelayed(timeout, 10_000L)
      ContextCompat.startForegroundService(activity, intent)
    } catch (error: Exception) {
      handler.removeCallbacks(timeout)
      if (settled.compareAndSet(false, true)) {
        finishOrphan()
        invoke.reject(error.message ?: "无法启动后台任务，请保持应用前台后重试")
      }
    }
  }

  @Command
  fun finish(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(TaskArgs::class.java)
      val intent = Intent(activity, BackgroundTasksService::class.java)
        .setAction(BackgroundTasksService.FINISH)
        .putExtra("taskId", args.taskId)
      activity.startService(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message)
    }
  }

  @Command
  fun status(invoke: Invoke) {
    val power = activity.getSystemService(PowerManager::class.java)
    val result = JSObject()
    result.put("batteryOptimizationIgnored", power.isIgnoringBatteryOptimizations(activity.packageName))
    result.put("notificationsEnabled", NotificationManagerCompat.from(activity).areNotificationsEnabled())
    result.put("activeTasks", BackgroundTaskRuntime.activeTasks)
    result.put("wakeLockHeld", BackgroundTaskRuntime.wakeLockHeld)
    result.put("networkAvailable", BackgroundTaskRuntime.networkAvailable)
    result.put("networkBlocked", BackgroundTaskRuntime.networkBlocked)
    result.put("lastError", BackgroundTaskRuntime.lastError)
    invoke.resolve(result)
  }

  @Command
  fun configure(invoke: Invoke) {
    try {
      val power = activity.getSystemService(PowerManager::class.java)
      if (!power.isIgnoringBatteryOptimizations(activity.packageName)) {
        activity.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
          .setData(Uri.parse("package:${activity.packageName}")))
      } else if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1902)
      } else {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:${activity.packageName}")))
      }
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message)
    }
  }
}
