use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::{BOOL, HRESULT};
use windows_core::implement;
use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use windows::Win32::System::Com::{IDataObject, FORMATETC, DVASPECT_CONTENT, TYMED_HGLOBAL};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
    CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use super::AddStatus;
use crate::shelf::ShelfStore;

thread_local! {
    /// OLE 侧只拿到裸指针，注册后这些对象由我们持有，避免窗口重建时提前释放。
    static BOUND_TARGETS: RefCell<Vec<IDropTarget>> = const { RefCell::new(Vec::new()) };
}

/// 拖动悬停状态。多个子窗口各自有一份 IDropTarget，但「有没有东西悬在窗口上」
/// 是整扇窗的事实，所以状态必须共享，否则子窗口之间一挪光标就会闪。
#[derive(Default)]
struct HoverState {
    entered: AtomicBool,
    seq: AtomicU64,
}

impl HoverState {
    fn enter(self: &Arc<Self>, app: &AppHandle) {
        // 每次进入都推进序号：排在后面的那次 DragLeave 看到序号变了就不会关掉高亮。
        self.seq.fetch_add(1, Ordering::SeqCst);
        if !self.entered.swap(true, Ordering::SeqCst) {
            emit_hover(app, true);
        }
    }

    /// 离开要等一下再确认：光标从 WebView2 的一个子窗口挪到另一个时，
    /// 系统会先来 DragLeave 再来 DragEnter，立刻关掉高亮会闪。
    fn leave(self: &Arc<Self>, app: &AppHandle) {
        let seq = self.seq.load(Ordering::SeqCst);
        let state = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            if state.seq.load(Ordering::SeqCst) != seq {
                return;
            }
            if state.entered.swap(false, Ordering::SeqCst) {
                emit_hover(&app, false);
            }
        });
    }

    /// 放下或这次拖放不接受时立刻收掉高亮，不做防抖。
    fn clear(&self, app: &AppHandle) {
        self.seq.fetch_add(1, Ordering::SeqCst);
        if self.entered.swap(false, Ordering::SeqCst) {
            emit_hover(app, false);
        }
    }
}

fn emit_hover(app: &AppHandle, over: bool) {
    let _ = app.emit_to("file-shelf-overlay", "file-shelf-drag-hover", over);
}

/// 关掉 WebView2 自带的外部拖放。
///
/// 不关的话，文件拖到窗口上会被 WebView2 自己吃下去（默认行为是当成导航），
/// 我们在窗口上登记的 IDropTarget 一次都收不到，看起来就是「拖上去毫无反应」。
/// wry 启用自家拖放时也是先 SetAllowExternalDrop(false)，再接管子窗口。
pub fn disable_webview_external_drop(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        window
            .with_webview(|webview| {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller4;
                use windows::core::Interface;
                // 失败只记日志：禁不掉外部拖放时，拖进来的文件会被 WebView2 吃掉，
                // 表现为「拖上去毫无反应」，没有这行日志就查不到原因。
                unsafe {
                    match webview.controller().cast::<ICoreWebView2Controller4>() {
                        Ok(controller) => {
                            if let Err(error) = controller.SetAllowExternalDrop(false) {
                                crate::utils::logger::log(
                                    "shelf",
                                    &format!("关闭 WebView2 外部拖放失败：{error}"),
                                );
                            }
                        }
                        Err(error) => crate::utils::logger::log(
                            "shelf",
                            &format!("当前 WebView2 不支持关闭外部拖放（需 1.0.1185+）：{error}"),
                        ),
                    }
                }
            })
            .map_err(|error| format!("关闭 WebView2 外部拖放失败：{error}"))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

/// 把暂存架窗口登记成放置目标。
///
/// 窗口创建时 `dragDropEnabled: false`，wry 不会在这扇窗上注册 IDropTarget。
/// 易失文件必须在 `Drop` 返回前复制完：系统拖放事件等到 Drop 返回后才交给前端，
/// 那时浏览器的临时文件可能已经删了。
///
/// 拖放命中测试落在最上层的窗口上，而 WebView2 的子窗口铺满整个客户区，
/// OLE 不会自己往父窗口回溯——只登记顶层窗口的话 Drop 永远不触发。
/// 所以照 wry 的做法枚举子窗口逐个登记。
///
/// `RevokeDragDrop` 不把旧目标交回来，所以这里没法包一层再转交。
/// 若句柄上已经有目标（例如 WebView2 自己注册的），先撤销再换上我们的。
/// 这扇窗只服务暂存架，替换不会丢掉别的接收方。
pub fn bind_shelf_drop_target(hwnd: HWND, app: AppHandle) -> Result<(), String> {
    let _ = unsafe { OleInitialize(None) };
    let mut children: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(collect_child),
            LPARAM(&mut children as *mut Vec<HWND> as isize),
        );
    }
    let hover = Arc::new(HoverState::default());
    let mut targets = Vec::new();
    let mut first_error = None;
    for child in children {
        match register_target(child, app.clone(), Arc::clone(&hover)) {
            Ok(target) => targets.push(target),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if targets.is_empty() {
        // 子窗口还没建出来（极少见）时退回到顶层窗口，至少不静默失败。
        let error = first_error.unwrap_or_else(|| "没有可登记的拖放窗口".to_string());
        targets.push(register_target(hwnd, app, hover).map_err(|_| error)?);
    }
    let count = targets.len();
    BOUND_TARGETS.with(|bound| bound.borrow_mut().extend(targets));
    crate::utils::logger::log("shelf", &format!("拖放目标已登记到 {count} 个窗口"));
    Ok(())
}

unsafe extern "system" fn collect_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let children = &mut *(lparam.0 as *mut Vec<HWND>);
    children.push(hwnd);
    BOOL(1)
}

fn register_target(
    hwnd: HWND,
    app: AppHandle,
    hover: Arc<HoverState>,
) -> Result<IDropTarget, String> {
    let target: IDropTarget = ShelfDropTarget {
        app,
        accepts: AtomicBool::new(false),
        hover,
    }
    .into();
    let _ = unsafe { RevokeDragDrop(hwnd) };
    unsafe { RegisterDragDrop(hwnd, &target) }
        .map(|()| target)
        .map_err(|error| format!("无法登记拖放目标：{error}"))
}

#[implement(IDropTarget)]
struct ShelfDropTarget {
    app: AppHandle,
    /// DragEnter 时记下对方有没有文件。DragOver 拿不到数据对象，
    /// 不记住的话，文本拖进来也会变成复制光标。
    accepts: AtomicBool,
    /// 所有子窗口共用，前端据此播放「松手放入」的引导动画。
    hover: Arc<HoverState>,
}

impl IDropTarget_Impl for ShelfDropTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: windows::core::Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let accepts = !self.store_is_dragging() && offers_files(pdataobj);
        self.accepts.store(accepts, Ordering::SeqCst);
        if accepts {
            self.hover.enter(&self.app);
        } else {
            // 拖的是文本/链接（或者正在从自己拖出）：不能继续显示「松手放入」。
            self.hover.clear(&self.app);
        }
        write_effect(
            pdweffect,
            if accepts { DROPEFFECT_COPY } else { DROPEFFECT(0) },
        );
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let accepts = self.accepts.load(Ordering::SeqCst) && !self.store_is_dragging();
        write_effect(
            pdweffect,
            if accepts { DROPEFFECT_COPY } else { DROPEFFECT(0) },
        );
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        self.accepts.store(false, Ordering::SeqCst);
        self.hover.leave(&self.app);
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: windows::core::Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        // 放下就收掉引导动画，后面无论收不收这件东西都不该继续亮着。
        self.hover.clear(&self.app);
        // 正在从暂存架拖出时，落回自己的整批都忽略。不按路径挑。
        // 没有文件的拖放（文本、链接）在 DragEnter 时已经拒绝。
        if self.store_is_dragging() || !self.accepts.load(Ordering::SeqCst) {
            write_effect(pdweffect, DROPEFFECT(0));
            return Ok(());
        }
        let Some(store) = self.app.try_state::<ShelfStore>() else {
            write_effect(pdweffect, DROPEFFECT(0));
            return Ok(());
        };
        let paths = paths_from_data(pdataobj);
        if paths.is_empty() {
            write_effect(pdweffect, DROPEFFECT(0));
            return Ok(());
        }
        let results = store.add_paths(&paths);
        // 一项都没收下时不能回复制。回了复制，浏览器会删掉临时文件，文件却不在暂存架里。
        let took = results.iter().any(|result| {
            matches!(result.status, AddStatus::Added | AddStatus::Topped)
        });
        write_effect(
            pdweffect,
            if took { DROPEFFECT_COPY } else { DROPEFFECT(0) },
        );
        if results.iter().any(|result| result.status != AddStatus::Ignored) {
            let _ = self.app.emit_to("file-shelf-overlay", "file-shelf-changed", &results);
        }
        Ok(())
    }
}

impl ShelfDropTarget_Impl {
    fn store_is_dragging(&self) -> bool {
        self.app
            .try_state::<ShelfStore>()
            .is_some_and(|store| store.is_dragging())
    }
}

fn write_effect(slot: *mut DROPEFFECT, effect: DROPEFFECT) {
    if !slot.is_null() {
        unsafe { *slot = effect };
    }
}

fn offers_files(data: windows::core::Ref<'_, IDataObject>) -> bool {
    let Some(data) = data.as_ref() else {
        return false;
    };
    let format = hdrop_format();
    let result = unsafe { data.QueryGetData(&format) };
    result == HRESULT(0)
}

fn paths_from_data(data: windows::core::Ref<'_, IDataObject>) -> Vec<std::path::PathBuf> {
    let Some(data) = data.as_ref() else {
        return Vec::new();
    };
    let format = hdrop_format();
    let mut medium = match unsafe { data.GetData(&format) } {
        Ok(medium) => medium,
        Err(_) => return Vec::new(),
    };
    let paths = unsafe {
        if medium.tymed & (TYMED_HGLOBAL.0 as u32) == 0 {
            Vec::new()
        } else {
            let hdrop = HDROP(medium.u.hGlobal.0);
            let count = DragQueryFileW(hdrop, u32::MAX, None);
            let mut paths = Vec::with_capacity(count as usize);
            for index in 0..count {
                let len = DragQueryFileW(hdrop, index, None) as usize;
                let mut buffer = vec![0u16; len + 1];
                let written = DragQueryFileW(hdrop, index, Some(&mut buffer)) as usize;
                let end = written.min(buffer.len());
                let text = String::from_utf16_lossy(&buffer[..end]);
                let text = text.trim_end_matches('\0');
                if !text.is_empty() {
                    paths.push(std::path::PathBuf::from(text));
                }
            }
            paths
        }
    };
    unsafe { ReleaseStgMedium(&mut medium) };
    paths
}

fn hdrop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}
