//! 实机 OCR 精度基准测试。
//!
//! 运行方式：cargo test ocr_acc -- --ignored --nocapture
//!
//! 前置条件：Chrome 打开 test_ocr.html（窗口位置 (10,10)）

use super::*;

/// Levenshtein 距离归一化准确率
fn char_accuracy(expected: &str, actual: &str) -> f64 {
    let e: Vec<char> = expected.trim().chars().collect();
    let a: Vec<char> = actual.trim().chars().collect();
    if e.is_empty() {
        return if a.is_empty() { 1.0 } else { 0.0 };
    }
    let n = e.len();
    let m = a.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in dp.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in dp[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + if e[i - 1] == a[j - 1] { 0 } else { 1 });
        }
    }
    1.0 - (dp[n][m] as f64 / n.max(m) as f64)
}

fn run_test(svc: &OcrService, label: &str, expected: &str, left: i32, top: i32, w: u32, h: u32) {
    println!("\n═══ {} ═══", label);
    println!("  区域: ({},{}) {}×{}", left, top, w, h);
    let bgra = crate::screenshot::capture_screen_region(left, top, w, h).expect("截屏失败");
    match svc.recognize_bgra(&bgra, w, h) {
        Ok(r) => {
            let acc = char_accuracy(expected, &r.text);
            println!("  引擎: {} | 耗时: {}ms", r.engine, r.elapsed_ms);
            println!("  预期 ({}c): [{}]", expected.chars().count(), expected);
            println!("  实际 ({}c): [{}]", r.text.chars().count(), r.text);
            println!("  准确率: {:.1}%", acc * 100.0);
        }
        Err(e) => println!("  ❌ {}", e),
    }
}

// ═══ Chrome 浏览器测试 (window=10,10, content≈10,50) ═══

#[test]
#[ignore]
fn ocr_acc_cn() {
    run_test(
        &OcrService::new(None, None),
        "中文",
        "这是一段用于测试OCR识别准确性的中文短文。OCR技术能将图片中的文字转换为可编辑的文本。",
        18,
        55,
        1280,
        28,
    );
}

#[test]
#[ignore]
fn ocr_acc_en() {
    run_test(
        &OcrService::new(None, None),
        "英文",
        "Hello World! This is an OCR test with English and Chinese mixed text.",
        18,
        85,
        1280,
        28,
    );
}

#[test]
#[ignore]
fn ocr_acc_num() {
    run_test(
        &OcrService::new(None, None),
        "数字",
        "数字测试：1+1=2  3.14159  2024/01/01  100%  温度：25°C  ￥99.99  (555)123-4567",
        18,
        115,
        1280,
        28,
    );
}

#[test]
#[ignore]
fn ocr_acc_sym() {
    run_test(
        &OcrService::new(None, None),
        "符号",
        "符号测试：@ # $ % ^ & * ( ) _ + - = [ ] { } < > ? / ! ~",
        18,
        145,
        1280,
        28,
    );
}

#[test]
#[ignore]
fn ocr_acc_mix() {
    run_test(
        &OcrService::new(None, None),
        "中英混排",
        "中英混排：Levitaire service 是一个 Windows 桌面悬浮窗工具，支持 AI、OCR、TTS、STT 等功能。",
        18,
        175,
        1280,
        28,
    );
}

#[test]
#[ignore]
fn ocr_acc_all() {
    let expected = "\
这是一段用于测试OCR识别准确性的中文短文。OCR技术能将图片中的文字转换为可编辑的文本。\n\
Hello World! This is an OCR test with English and Chinese mixed text.\n\
数字测试：1+1=2  3.14159  2024/01/01  100%  温度：25°C  ￥99.99  (555)123-4567\n\
符号测试：@ # $ % ^ & * ( ) _ + - = [ ] { } < > ? / ! ~\n\
中英混排：Levitaire service 是一个 Windows 桌面悬浮窗工具，支持 AI、OCR、TTS、STT 等功能。";
    run_test(
        &OcrService::new(None, None),
        "全部5行",
        expected,
        18,
        50,
        1280,
        160,
    );
}

#[test]
#[ignore]
fn ocr_acc_stable() {
    let svc = OcrService::new(None, None);
    println!("\n═══ 稳定性 (10次连续) ═══");
    let bgra = crate::screenshot::capture_screen_region(18, 55, 1280, 28).expect("截屏失败");
    let mut texts = Vec::new();
    let mut ms = 0u64;
    for i in 0..10 {
        match svc.recognize_bgra(&bgra, 1280, 28) {
            Ok(r) => {
                ms += r.elapsed_ms;
                println!(
                    "  #{} {}ms [{}]",
                    i + 1,
                    r.elapsed_ms,
                    &r.text[..r.text.len().min(50)]
                );
                texts.push(r.text);
            }
            Err(e) => println!("  #{} ❌ {}", i + 1, e),
        }
    }
    println!(
        "  平均: {}ms, 一致性: {}",
        ms / 10,
        if texts.iter().all(|s| s == &texts[0]) {
            "✅"
        } else {
            "⚠"
        }
    );
}
