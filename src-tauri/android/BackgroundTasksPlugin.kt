package app.imagestudio.background

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class TaskArgs {
  lateinit var taskId: String
}

@TauriPlugin
class BackgroundTasksPlugin(private val activity: Activity) : Plugin(activity) {
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
