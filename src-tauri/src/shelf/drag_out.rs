use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use windows::core::{BOOL, HRESULT};
use windows_core::implement;
use windows::Win32::Foundation::{
    DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
    DV_E_FORMATETC, E_INVALIDARG, E_NOTIMPL, OLE_E_ADVISENOTSUPPORTED, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl,
    IEnumSTATDATA, FORMATETC, DATADIR_GET, DVASPECT_CONTENT, STGMEDIUM, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::MK_LBUTTON;
use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;

use super::add::strip_extended_prefix;
use super::ShelfStore;

/// Preferred DropEffect 里的 DROPEFFECT_COPY。测试只核对这个值，不核对 IDropSource。
pub const PREFERRED_DROP_EFFECT: u32 = 1;

pub fn begin_drag(store: &ShelfStore, ids: &[String]) -> Result<(), String> {
    if store
        .dragging
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("正在拖出".to_string());
    }
    let guard = DragFlagGuard(store);
    let paths = store.paths_for_drag(ids)?;
    // WebView2 这时通常还占着鼠标捕获。不先 ReleaseCapture，DoDragDrop 收不到松开，
    // 拖出会一直挂着。这一步是必须的。
    unsafe {
        let _ = ReleaseCapture();
    }
    let data: IDataObject = ShelfDataObject::new(paths).into();
    let source: IDropSource = ShelfDropSource.into();
    let mut effect = DROPEFFECT(0);
    let hr = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };
    drop(guard);
    if hr == S_OK || hr == DRAGDROP_S_DROP || hr == DRAGDROP_S_CANCEL {
        Ok(())
    } else {
        Err(format!("拖出失败：{hr:?}"))
    }
}

struct DragFlagGuard<'a>(&'a ShelfStore);
impl Drop for DragFlagGuard<'_> {
    fn drop(&mut self) {
        self.0.set_dragging(false);
    }
}

/// IDropSource 只决定继续、取消或放下，不返回复制/移动效果。
/// 效果由 DoDragDrop 的 DROPEFFECT_COPY 和数据对象里的 Preferred DropEffect 决定。
#[implement(IDropSource)]
struct ShelfDropSource;

impl IDropSource_Impl for ShelfDropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if grfkeystate.0 & MK_LBUTTON.0 == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

#[implement(IDataObject)]
struct ShelfDataObject {
    paths: Vec<PathBuf>,
    preferred: u16,
}

impl ShelfDataObject {
    fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            paths,
            preferred: preferred_format(),
        }
    }

    fn formats(&self) -> Vec<FORMATETC> {
        let mut formats = vec![hdrop_format()];
        if self.preferred != 0 {
            formats.push(format_etc(self.preferred));
        }
        formats
    }
}

impl IDataObject_Impl for ShelfDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        if pformatetcin.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let format = unsafe { &*pformatetcin };
        if format.cfFormat == CF_HDROP.0 {
            return hglobal_medium(&hdrop_bytes(&self.paths));
        }
        if self.preferred != 0 && format.cfFormat == self.preferred {
            let bytes = PREFERRED_DROP_EFFECT.to_le_bytes();
            return hglobal_medium(&bytes);
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        if pformatetc.is_null() {
            return E_INVALIDARG;
        }
        let format = unsafe { &*pformatetc };
        let offered = format.cfFormat == CF_HDROP.0
            || (self.preferred != 0 && format.cfFormat == self.preferred);
        let tymed_ok = format.tymed & (TYMED_HGLOBAL.0 as u32) != 0;
        if offered && tymed_ok {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        pformatetcin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        // 没有更规范的格式。返回 E_NOTIMPL 时，资源管理器会丢掉这次拖放。
        if pformatetcin.is_null() || pformatetcout.is_null() {
            return E_INVALIDARG;
        }
        unsafe {
            *pformatetcout = *pformatetcin;
            (*pformatetcout).ptd = std::ptr::null_mut();
        }
        DATA_S_SAMEFORMATETC
    }

    fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        Ok(ShelfFormatEnum {
            formats: self.formats().into_iter().map(|format| format.cfFormat).collect(),
            index: AtomicU32::new(0),
        }
        .into())
    }

    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: windows::core::Ref<'_, IAdviseSink>) -> windows::core::Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _: u32) -> windows::core::Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

#[implement(IEnumFORMATETC)]
struct ShelfFormatEnum {
    formats: Vec<u16>,
    index: AtomicU32,
}

impl IEnumFORMATETC_Impl for ShelfFormatEnum_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
        if rgelt.is_null() || celt == 0 {
            return E_INVALIDARG;
        }
        let mut fetched = 0u32;
        while fetched < celt {
            let index = self.index.fetch_add(1, Ordering::SeqCst) as usize;
            if index >= self.formats.len() {
                self.index.store(self.formats.len() as u32, Ordering::SeqCst);
                break;
            }
            unsafe {
                *rgelt.add(fetched as usize) = format_etc(self.formats[index]);
            }
            fetched += 1;
        }
        if !pceltfetched.is_null() {
            unsafe { *pceltfetched = fetched };
        }
        if fetched == celt { S_OK } else { S_FALSE }
    }

    fn Skip(&self, celt: u32) -> windows::core::Result<()> {
        let next = self.index.load(Ordering::SeqCst).saturating_add(celt);
        if next > self.formats.len() as u32 {
            self.index.store(self.formats.len() as u32, Ordering::SeqCst);
            return Err(S_FALSE.into());
        }
        self.index.store(next, Ordering::SeqCst);
        Ok(())
    }

    fn Reset(&self) -> windows::core::Result<()> {
        self.index.store(0, Ordering::SeqCst);
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IEnumFORMATETC> {
        Ok(ShelfFormatEnum {
            formats: self.formats.clone(),
            index: AtomicU32::new(self.index.load(Ordering::SeqCst)),
        }
        .into())
    }
}

pub fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
    let mut body = Vec::new();
    for path in paths {
        let shown = strip_extended_prefix(&path.to_string_lossy().replace('/', "\\"));
        for unit in shown.encode_utf16() {
            body.extend_from_slice(&unit.to_le_bytes());
        }
        body.extend_from_slice(&0u16.to_le_bytes());
    }
    body.extend_from_slice(&0u16.to_le_bytes());
    let mut bytes = Vec::with_capacity(20 + body.len());
    bytes.extend_from_slice(&20u32.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&body);
    bytes
}

fn hglobal_medium(bytes: &[u8]) -> windows::core::Result<STGMEDIUM> {
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len())? };
    let ptr = unsafe { GlobalLock(handle) };
    if ptr.is_null() {
        unsafe { windows::Win32::Foundation::GlobalFree(Some(handle))? };
        return Err(E_NOTIMPL.into());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(handle);
    }
    let mut medium = STGMEDIUM::default();
    medium.tymed = TYMED_HGLOBAL.0 as u32;
    medium.u.hGlobal = handle;
    Ok(medium)
}

fn hdrop_format() -> FORMATETC {
    format_etc(CF_HDROP.0)
}

fn format_etc(format: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn preferred_format() -> u16 {
    unsafe { RegisterClipboardFormatW(windows::core::w!("Preferred DropEffect")) as u16 }
}
