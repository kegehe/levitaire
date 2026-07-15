use windows::Win32::Foundation::HLOCAL;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

/// CRYPTPROTECT_UI_FORBIDDEN: 禁止 UI 交互（用于服务/后台场景）
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x4;

/// 通过 DPAPI 加密数据
///
/// 使用 windows crate 的安全绑定调用 CryptProtectData，
/// 绑定当前用户，不可跨用户/机器迁移。
pub fn encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = CRYPT_INTEGER_BLOB::default();
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        // DPAPI 仅读取 input，struct 要求 *mut 但实际不会写入
        pbData: plaintext.as_ptr().cast_mut(),
    };

    unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("CryptProtectData 失败: {}", e))?;
    }

    let encrypted = extract_blob_data(&output);
    free_blob_data(&mut output);
    Ok(encrypted)
}

/// 通过 DPAPI 解密数据
///
/// 使用 windows crate 的安全绑定调用 CryptUnprotectData。
pub fn decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = CRYPT_INTEGER_BLOB::default();
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        // DPAPI 仅读取 input，struct 要求 *mut 但实际不会写入
        pbData: ciphertext.as_ptr().cast_mut(),
    };

    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
            .map_err(|e| format!("CryptUnprotectData 失败: {}", e))?;
    }

    let decrypted = extract_blob_data(&output);
    free_blob_data(&mut output);
    Ok(decrypted)
}

/// 从 CRYPT_INTEGER_BLOB 提取数据副本
fn extract_blob_data(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() }
}

/// 释放 CRYPT_INTEGER_BLOB 的 pbData（DPAPI 使用 LocalAlloc 分配）
fn free_blob_data(blob: &mut CRYPT_INTEGER_BLOB) {
    if !blob.pbData.is_null() {
        unsafe {
            let _ = windows::Win32::Foundation::LocalFree(Some(HLOCAL(blob.pbData as *mut _)));
        }
        blob.pbData = std::ptr::null_mut();
        blob.cbData = 0;
    }
}

/// 将字节数组编码为十六进制字符串
pub fn to_hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 将十六进制字符串解码为字节数组
pub fn from_hex(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("无效的十六进制字符串长度".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| format!("十六进制解码失败: {}", e))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hex_roundtrip() {
        let data = vec![0u8, 1, 2, 127, 128, 255];
        let hex = to_hex(&data);
        let decoded = from_hex(&hex).unwrap();
        assert_eq!(data, decoded);
    }

    #[test]
    fn test_hex_empty() {
        assert_eq!(to_hex(&[]), "");
        assert_eq!(from_hex("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn test_hex_invalid_length() {
        assert!(from_hex("1").is_err());
        assert!(from_hex("123").is_err());
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = b"test-api-key-12345";
        let encrypted = encrypt(plaintext).unwrap();
        assert_ne!(&encrypted, plaintext, "加密后不应与明文相同");
        let decrypted = decrypt(&encrypted).unwrap();
        assert_eq!(&decrypted, plaintext, "解密后应与明文一致");
    }

    #[test]
    fn test_encrypt_empty_input() {
        let encrypted = encrypt(b"").unwrap();
        let decrypted = decrypt(&encrypted).unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn test_decrypt_invalid_data() {
        assert!(decrypt(&[0xFF, 0xFE, 0xFD]).is_err());
    }
}
