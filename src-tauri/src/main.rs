// Windows 下隐藏控制台窗口（release 构建时生效）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gpt_image_studio_lib::run()
}
