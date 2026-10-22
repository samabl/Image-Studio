package app.imagestudio.background

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Environment
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

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "legacyAlbum")])
class BackgroundTasksPlugin(private val activity: Activity) : Plugin(activity) {
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
    try {
      val args = invoke.parseArgs(TaskArgs::class.java)
      require(args.taskId.isNotBlank())
      val intent = Intent(activity, BackgroundTasksService::class.java)
        .setAction(BackgroundTasksService.START)
        .putExtra("taskId", args.taskId)
      ContextCompat.startForegroundService(activity, intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法启动后台任务，请保持应用前台后重试")
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
