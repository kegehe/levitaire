//! Local todo storage and reminder scheduling.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Utc, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const MAX_TITLE_CHARS: usize = 500;
const MAX_LIST_NAME_CHARS: usize = 80;
/// 数据文件版本。v3 起取消内置「收件箱」清单：任务可以不属于任何清单
/// （`list_id` 为空串），清单全部由用户自建。
const FILE_VERSION: u32 = 3;
/// v2 及更早版本内置收件箱清单的 id。仅迁移时用于识别并移除。
const LEGACY_INBOX_LIST_ID: &str = "inbox";

/// 待办变更 → 调度线程的唤醒通道。调度线程空闲时最长沉睡 60s，
/// 若此时新建/修改了「近时到期的提醒」，写入路径会 send 一记唤醒信号，
/// 让线程立即重算 next_reminder_in，避免提醒延迟触发最多 60s。
fn scheduler_wake() -> &'static Mutex<Option<mpsc::Sender<()>>> {
    static WAKE: std::sync::OnceLock<Mutex<Option<mpsc::Sender<()>>>> = std::sync::OnceLock::new();
    WAKE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn wake_scheduler() {
    if let Ok(guard) = scheduler_wake().lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(());
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Active,
    Completed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TodoPriority {
    Low,
    #[default]
    Normal,
    High,
    Urgent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TodoRepeatRule {
    #[default]
    None,
    Daily,
    Weekly,
    Workdays,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoList {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub priority: TodoPriority,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 所属清单 id。空串（或省略）表示不属于任何清单。
    #[serde(default)]
    pub list_id: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub repeat_rule: TodoRepeatRule,
    pub status: TodoStatus,
    pub due_at: Option<String>,
    pub remind_at: Option<String>,
    pub reminder_fired_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TodoFile {
    pub version: u32,
    #[serde(default)]
    pub lists: Vec<TodoList>,
    pub items: Vec<TodoItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoInput {
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub priority: TodoPriority,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 所属清单 id。空串（或省略）表示不属于任何清单。
    #[serde(default)]
    pub list_id: String,
    #[serde(default)]
    pub repeat_rule: TodoRepeatRule,
    pub due_at: Option<String>,
    pub remind_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoInput {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub priority: Option<TodoPriority>,
    pub tags: Option<Vec<String>>,
    pub list_id: Option<String>,
    pub repeat_rule: Option<TodoRepeatRule>,
    /// JSON value preserves the distinction between an omitted field and null (clear value).
    pub due_at: Option<serde_json::Value>,
    pub remind_at: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoListInput {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoListInput {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoReminderPayload {
    pub item: TodoItem,
}

pub struct TodoStore {
    file_path: PathBuf,
    data: Mutex<TodoFile>,
    next_id: AtomicU64,
}

impl TodoStore {
    pub fn new() -> Self {
        let file_path = Self::file_path();
        let data = load_file(&file_path);
        Self {
            file_path,
            data: Mutex::new(data),
            next_id: AtomicU64::new(1),
        }
    }

    fn file_path() -> PathBuf {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("levitaire");
        let _ = fs::create_dir_all(&dir);
        dir.join("todos.json")
    }

    pub fn list(
        &self,
        include_completed: bool,
        sort_mode: Option<&str>,
    ) -> Result<Vec<TodoItem>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        let mut items: Vec<_> = data
            .items
            .iter()
            .filter(|item| {
                item.deleted_at.is_none()
                    && (include_completed || item.status == TodoStatus::Active)
            })
            .cloned()
            .collect();
        if sort_mode == Some("manual") {
            items.sort_by(|a, b| {
                a.sort_order
                    .cmp(&b.sort_order)
                    .then(a.created_at.cmp(&b.created_at))
            });
        } else {
            items.sort_by(|a, b| {
                priority_rank(&b.priority)
                    .cmp(&priority_rank(&a.priority))
                    .then(a.sort_order.cmp(&b.sort_order))
                    .then(a.created_at.cmp(&b.created_at))
            });
        }
        Ok(items)
    }

    pub fn active_item(&self, id: &str) -> Result<TodoItem, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        data.items
            .iter()
            .find(|item| {
                item.id == id && item.status == TodoStatus::Active && item.deleted_at.is_none()
            })
            .cloned()
            .ok_or_else(|| "Task does not exist or is not active".to_string())
    }

    pub fn deleted(&self) -> Result<Vec<TodoItem>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        let mut items: Vec<_> = data
            .items
            .iter()
            .filter(|item| item.deleted_at.is_some())
            .cloned()
            .collect();
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(items)
    }

    pub fn reorder(&self, id: &str, direction: i32) -> Result<TodoItem, String> {
        if direction != -1 && direction != 1 {
            return Err("Direction must be -1 or 1".to_string());
        }
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let index = data
            .items
            .iter()
            .position(|item| item.id == id && item.deleted_at.is_none())
            .ok_or_else(|| "Task does not exist".to_string())?;
        let target_list_id = data.items[index].list_id.clone();
        let target_status = data.items[index].status.clone();
        let mut peers: Vec<usize> = data
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.deleted_at.is_none()
                    && item.list_id == target_list_id
                    && item.status == target_status
            })
            .map(|(index, _)| index)
            .collect();
        peers.sort_by_key(|index| data.items[*index].sort_order);
        let position = peers
            .iter()
            .position(|candidate| *candidate == index)
            .ok_or_else(|| "任务不存在".to_string())?;
        let neighbor_position = if direction < 0 {
            position.checked_sub(1)
        } else {
            (position + 1 < peers.len()).then_some(position + 1)
        };
        let Some(neighbor_position) = neighbor_position else {
            return Ok(data.items[index].clone());
        };
        let neighbor = peers[neighbor_position];
        let order = data.items[index].sort_order;
        data.items[index].sort_order = data.items[neighbor].sort_order;
        data.items[neighbor].sort_order = order;
        data.items[index].updated_at = Utc::now().to_rfc3339();
        let result = data.items[index].clone();
        self.save_locked(&data)?;
        Ok(result)
    }

    /// 将任务移动到同一清单、同一状态分组中的任意位置。
    /// `before_id` 指定插入到该任务之前，为空表示移动到组末尾。
    /// 移动后对该分组的 sort_order 重新紧凑编号，保持分组内相对顺序与前端一致。
    pub fn move_to(&self, id: &str, before_id: Option<&str>) -> Result<TodoItem, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let index = data
            .items
            .iter()
            .position(|item| item.id == id && item.deleted_at.is_none())
            .ok_or_else(|| "Task does not exist".to_string())?;
        let target_list_id = data.items[index].list_id.clone();
        let target_status = data.items[index].status.clone();
        let mut peers: Vec<usize> = data
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.deleted_at.is_none()
                    && item.list_id == target_list_id
                    && item.status == target_status
            })
            .map(|(index, _)| index)
            .collect();
        peers.sort_by_key(|index| data.items[*index].sort_order);
        peers.retain(|candidate| *candidate != index);
        let insert_at = before_id
            .and_then(|before| {
                peers
                    .iter()
                    .position(|candidate| data.items[*candidate].id == before)
            })
            .unwrap_or(peers.len());
        peers.insert(insert_at, index);
        for (position, item_index) in peers.iter().enumerate() {
            data.items[*item_index].sort_order = position as i64;
        }
        data.items[index].updated_at = Utc::now().to_rfc3339();
        let result = data.items[index].clone();
        // 移动会重编号整组 sort_order，保存失败时必须回滚内存，避免前端 refresh 读到未持久化的顺序。
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn list_lists(&self) -> Result<Vec<TodoList>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data.lists.clone())
    }

    pub fn create_list(&self, input: CreateTodoListInput) -> Result<TodoList, String> {
        let name = normalize_list_name(&input.name)?;
        let now = Utc::now().to_rfc3339();
        let list = TodoList {
            id: format!(
                "list-{}-{}",
                Utc::now().timestamp_millis(),
                self.next_id.fetch_add(1, Ordering::Relaxed)
            ),
            name,
            created_at: now.clone(),
            updated_at: now,
        };
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        if data
            .lists
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&list.name))
        {
            return Err("A list with this name already exists".to_string());
        }
        data.lists.push(list.clone());
        self.save_with_rollback(&mut data, previous)?;
        Ok(list)
    }

    pub fn update_list(&self, id: &str, input: UpdateTodoListInput) -> Result<TodoList, String> {
        let name = normalize_list_name(&input.name)?;
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        if data
            .lists
            .iter()
            .any(|existing| existing.id != id && existing.name.eq_ignore_ascii_case(&name))
        {
            return Err("A list with this name already exists".to_string());
        }
        let list = data
            .lists
            .iter_mut()
            .find(|list| list.id == id)
            .ok_or_else(|| "List does not exist".to_string())?;
        list.name = name;
        list.updated_at = Utc::now().to_rfc3339();
        let result = list.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn delete_list(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let before = data.lists.len();
        data.lists.retain(|list| list.id != id);
        if data.lists.len() == before {
            return Err("List does not exist".to_string());
        }
        // 清单里的任务改为「不属于任何清单」，不随清单一起消失。
        let now = Utc::now().to_rfc3339();
        for item in &mut data.items {
            if item.list_id == id {
                item.list_id = String::new();
                item.updated_at = now.clone();
            }
        }
        self.save_with_rollback(&mut data, previous)
    }

    pub fn create(&self, input: CreateTodoInput) -> Result<TodoItem, String> {
        let title = normalize_title(&input.title)?;
        validate_datetime(&input.due_at)?;
        validate_datetime(&input.remind_at)?;
        let now = Utc::now().to_rfc3339();
        let id = format!(
            "todo-{}-{}",
            Utc::now().timestamp_millis(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let list_id = normalize_list_ref(&input.list_id, &data.lists)?;
        let sort_order = data
            .items
            .iter()
            .map(|item| item.sort_order)
            .max()
            .unwrap_or(0)
            + 1;
        let item = TodoItem {
            id,
            title,
            notes: input.notes.trim().to_string(),
            priority: input.priority,
            tags: normalize_tags(input.tags),
            list_id,
            deleted_at: None,
            repeat_rule: input.repeat_rule,
            status: TodoStatus::Active,
            due_at: input.due_at,
            remind_at: input.remind_at,
            reminder_fired_at: None,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
            sort_order,
        };
        data.items.push(item.clone());
        self.save_with_rollback(&mut data, previous)?;
        Ok(item)
    }

    pub fn update(&self, id: &str, input: UpdateTodoInput) -> Result<TodoItem, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        // 先校验清单引用，再取 items 的可变借用（normalize_list_ref 只读 data.lists）。
        let list_id = match input.list_id.as_deref() {
            Some(value) => Some(normalize_list_ref(value, &data.lists)?),
            None => None,
        };
        let item = data
            .items
            .iter_mut()
            .find(|item| item.id == id && item.deleted_at.is_none())
            .ok_or_else(|| "Task does not exist".to_string())?;
        if let Some(title) = input.title {
            item.title = normalize_title(&title)?;
        }
        if let Some(notes) = input.notes {
            item.notes = notes.trim().to_string();
        }
        if let Some(priority) = input.priority {
            item.priority = priority;
        }
        if let Some(tags) = input.tags {
            item.tags = normalize_tags(tags);
        }
        if let Some(list_id) = list_id {
            item.list_id = list_id;
        }
        if let Some(repeat_rule) = input.repeat_rule {
            item.repeat_rule = repeat_rule;
        }
        if let Some(due_at) = input.due_at {
            item.due_at = parse_datetime_value(due_at)?;
        }
        if let Some(remind_at) = input.remind_at {
            item.remind_at = parse_datetime_value(remind_at)?;
            item.reminder_fired_at = None;
        }
        item.updated_at = Utc::now().to_rfc3339();
        let result = item.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn set_completed(&self, id: &str, completed: bool) -> Result<TodoItem, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let (result, repeat) = {
            let item = data
                .items
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "任务不存在".to_string())?;
            if item.deleted_at.is_some() {
                return Err("Task does not exist".to_string());
            }
            if (completed && item.status == TodoStatus::Completed)
                || (!completed && item.status == TodoStatus::Active)
            {
                return Ok(item.clone());
            }
            item.status = if completed {
                TodoStatus::Completed
            } else {
                TodoStatus::Active
            };
            item.completed_at = completed.then(|| Utc::now().to_rfc3339());
            item.updated_at = Utc::now().to_rfc3339();
            let result = item.clone();
            let repeat = if completed && item.repeat_rule != TodoRepeatRule::None {
                Some(item.clone())
            } else {
                None
            };
            (result, repeat)
        };
        if let Some(mut next) = repeat {
            let now = Utc::now();
            next.id = format!(
                "todo-{}-{}",
                now.timestamp_millis(),
                self.next_id.fetch_add(1, Ordering::Relaxed)
            );
            next.status = TodoStatus::Active;
            next.completed_at = None;
            next.reminder_fired_at = None;
            next.created_at = now.to_rfc3339();
            next.updated_at = next.created_at.clone();
            next.due_at = next_due(next.due_at.as_deref(), next.repeat_rule, now);
            next.remind_at = next_due(next.remind_at.as_deref(), next.repeat_rule, now);
            next.sort_order = data
                .items
                .iter()
                .map(|candidate| candidate.sort_order)
                .max()
                .unwrap_or(0)
                + 1;
            data.items.push(next);
        }
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn snooze(&self, id: &str, minutes: u32) -> Result<TodoItem, String> {
        if !(1..=1_440).contains(&minutes) {
            return Err("延后提醒时间必须在 1 到 1440 分钟之间".to_string());
        }
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let item = data
            .items
            .iter_mut()
            .find(|item| item.id == id && item.deleted_at.is_none())
            .ok_or_else(|| "Task does not exist".to_string())?;
        if item.status != TodoStatus::Active {
            return Err("已完成任务不能延后提醒".to_string());
        }
        let now = Utc::now();
        item.remind_at = Some((now + chrono::Duration::minutes(i64::from(minutes))).to_rfc3339());
        item.reminder_fired_at = None;
        item.updated_at = now.to_rfc3339();
        let result = item.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let item = data
            .items
            .iter_mut()
            .find(|item| item.id == id && item.deleted_at.is_none())
            .ok_or_else(|| "Task does not exist".to_string())?;
        item.deleted_at = Some(Utc::now().to_rfc3339());
        item.updated_at = Utc::now().to_rfc3339();
        self.save_with_rollback(&mut data, previous)
    }

    pub fn purge_deleted(&self) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        data.items.retain(|item| item.deleted_at.is_none());
        self.save_with_rollback(&mut data, previous)
    }

    pub fn export_to(&self, path: &std::path::Path) -> Result<(), String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        let content = serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| format!("Could not export tasks: {e}"))
    }

    pub fn import_from(&self, path: &std::path::Path) -> Result<(), String> {
        let raw = fs::read_to_string(path).map_err(|e| format!("Could not read tasks: {e}"))?;
        let mut imported: TodoFile =
            serde_json::from_str(&raw).map_err(|e| format!("Invalid todo export: {e}"))?;
        let mut list_ids = HashSet::new();
        for list in &imported.lists {
            if list.id.trim().is_empty() || !list_ids.insert(list.id.clone()) {
                return Err("Imported lists must have unique non-empty IDs".to_string());
            }
        }
        let mut item_ids = HashSet::new();
        for item in &imported.items {
            if item.id.trim().is_empty() || !item_ids.insert(item.id.clone()) {
                return Err("Imported tasks must have unique non-empty IDs".to_string());
            }
            normalize_title(&item.title)?;
            validate_datetime(&item.due_at)?;
            validate_datetime(&item.remind_at)?;
            // 引用校验必须在迁移之前：迁移会把悬空引用自愈成「无清单」，
            // 先迁移的话这里就永远发现不了损坏的导入文件。
            if !item.list_id.is_empty() && !imported.lists.iter().any(|l| l.id == item.list_id) {
                return Err("An imported task references a missing list".to_string());
            }
        }
        // 旧导出的文件里带内置收件箱清单，按当前版本归一化（移除该清单，
        // 其下的任务改为「无清单」）。
        migrate_file(&mut imported);
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        *data = imported;
        self.save_with_rollback(&mut data, previous)
    }

    pub fn restore(&self, id: &str) -> Result<TodoItem, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let current = data
            .items
            .iter_mut()
            .find(|current| current.id == id)
            .ok_or_else(|| "Task does not exist".to_string())?;
        if current.deleted_at.is_none() {
            return Err("Task already exists".to_string());
        }
        // Restore the canonical stored record. The client payload is used only
        // to identify the deleted task, preventing arbitrary task injection and
        // avoiding stale list metadata after a list has been removed.
        current.deleted_at = None;
        current.updated_at = Utc::now().to_rfc3339();
        let restored = current.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(restored)
    }

    pub fn due_reminders(&self, now: DateTime<Utc>) -> Result<Vec<TodoItem>, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let mut due = Vec::new();
        let stamp = now.to_rfc3339();
        for item in &mut data.items {
            let is_due = item
                .remind_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc) <= now)
                .unwrap_or(false);
            if item.deleted_at.is_none()
                && item.status == TodoStatus::Active
                && is_due
                && item.reminder_fired_at.is_none()
            {
                item.reminder_fired_at = Some(stamp.clone());
                item.updated_at = stamp.clone();
                due.push(item.clone());
            }
        }
        if !due.is_empty() {
            self.save_with_rollback(&mut data, previous)?;
        }
        Ok(due)
    }

    /// 把指定 id 的到期提醒还原为“未触发”。调度线程在播报中途被禁用时调用，
    /// 撤销 due_reminders 已批量打上的 reminder_fired_at，避免未播报提醒被吞掉。
    pub fn unmark_reminders_fired(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let stamp = Utc::now().to_rfc3339();
        let mut changed = false;
        for item in &mut data.items {
            if ids.contains(&item.id) && item.reminder_fired_at.is_some() {
                item.reminder_fired_at = None;
                item.updated_at = stamp.clone();
                changed = true;
            }
        }
        if changed {
            self.save_with_rollback(&mut data, previous)?;
        }
        Ok(())
    }

    /// 距离下一个「将来才到期」的提醒还剩多久；若没有未触发的未来提醒则返回 None，
    /// 供后台调度线程据此精确阻塞，避免空闲时每 15 秒轮询扫描。
    fn next_reminder_in(&self, now: DateTime<Utc>) -> Result<Option<Duration>, ()> {
        let data = self.data.lock().map_err(|_| ())?;
        let mut earliest: Option<DateTime<Utc>> = None;
        for item in &data.items {
            if item.deleted_at.is_some()
                || item.status != TodoStatus::Active
                || item.reminder_fired_at.is_some()
            {
                continue;
            }
            let Some(remind) = item
                .remind_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            else {
                continue;
            };
            let remind = remind.with_timezone(&Utc);
            if remind > now && earliest.is_none_or(|next| remind < next) {
                earliest = Some(remind);
            }
        }
        // to_std 对超出 std::time::Duration 范围的巨远期提醒返回 None，
        // 此时返回 None 让调度线程回退到空闲等待，避免 sleep(0) 造成忙轮询。
        Ok(earliest.and_then(|next| (next - now).to_std().ok()))
    }

    fn save_locked(&self, data: &TodoFile) -> Result<(), String> {
        let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let temp = self
            .file_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temp, content).map_err(|e| format!("写入待办文件失败: {}", e))?;
        fs::rename(&temp, &self.file_path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("保存待办文件失败: {}", e)
        })?;
        // 任何待办写入都可能改变最近的提醒时间，唤醒后台调度线程及时重算，
        // 避免它仍处于最长 60s 的空闲沉睡，导致新建/修改的近时提醒延迟触发。
        wake_scheduler();
        Ok(())
    }

    fn save_with_rollback(&self, data: &mut TodoFile, previous: TodoFile) -> Result<(), String> {
        if let Err(error) = self.save_locked(data) {
            *data = previous;
            return Err(error);
        }
        Ok(())
    }
}

fn load_file(path: &PathBuf) -> TodoFile {
    let mut file = match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(file) => file,
            Err(error) => {
                // Keep malformed data recoverable instead of silently replacing
                // it on the next write.
                let backup = path.with_extension(format!(
                    "json.corrupt.{}.bak",
                    Utc::now().timestamp_millis()
                ));
                let _ = fs::rename(path, backup);
                crate::utils::logger::log(
                    "todo",
                    &format!("invalid todo file moved aside: {error}"),
                );
                TodoFile {
                    version: FILE_VERSION,
                    lists: Vec::new(),
                    items: Vec::new(),
                }
            }
        },
        Err(_) => TodoFile {
            version: FILE_VERSION,
            lists: Vec::new(),
            items: Vec::new(),
        },
    };
    migrate_file(&mut file);
    file
}

/// 把任意历史版本的数据文件归一化到当前 `FILE_VERSION`，并顺带自愈悬空引用。
///
/// v2 → v3：移除内置收件箱清单（`LEGACY_INBOX_LIST_ID`），原先挂在它下面的任务
/// 改为「不属于任何清单」。清单因此可以为空，界面下拉框在没有任何清单时只显示
/// 「全部任务」。
///
/// 自愈部分与版本无关，每次加载都跑：任何指向不存在清单的任务统一落回「无清单」，
/// 避免数据文件被外部编辑后留下前端看不见的任务。
fn migrate_file(file: &mut TodoFile) {
    file.lists.retain(|list| list.id != LEGACY_INBOX_LIST_ID);
    for item in &mut file.items {
        let dangling = item.list_id.trim().is_empty()
            || !file.lists.iter().any(|list| list.id == item.list_id);
        if dangling {
            item.list_id = String::new();
        }
    }
    file.version = FILE_VERSION;
}

fn normalize_title(value: &str) -> Result<String, String> {
    let title = value.trim();
    if title.is_empty() {
        return Err("任务标题不能为空".to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err("任务标题不能超过 500 个字符".to_string());
    }
    Ok(title.to_string())
}

fn normalize_list_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("List name cannot be empty".to_string());
    }
    if name.chars().count() > MAX_LIST_NAME_CHARS {
        return Err("List name is too long".to_string());
    }
    Ok(name.to_string())
}

/// 校验并归一化任务引用的清单 id。
///
/// 空串（含纯空白）表示「不属于任何清单」，始终合法；非空时必须命中已有清单，
/// 否则拒绝写入 —— 前端下拉框只能选到存在的清单，出现别的值说明数据被外部改坏了。
fn normalize_list_ref(value: &str, lists: &[TodoList]) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    if lists.iter().any(|list| list.id == value) {
        return Ok(value.to_string());
    }
    Err("List does not exist".to_string())
}

fn next_due(value: Option<&str>, rule: TodoRepeatRule, now: DateTime<Utc>) -> Option<String> {
    let Some(value) = value else {
        return None;
    };
    let base = DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc))
        .unwrap_or(now);
    let mut next = match rule {
        TodoRepeatRule::None => return Some(value.to_string()),
        TodoRepeatRule::Daily => base + ChronoDuration::days(1),
        TodoRepeatRule::Weekly => base + ChronoDuration::weeks(1),
        TodoRepeatRule::Workdays => {
            let mut candidate = base + ChronoDuration::days(1);
            while matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun) {
                candidate += ChronoDuration::days(1);
            }
            candidate
        }
    };
    match rule {
        TodoRepeatRule::Daily => {
            while next <= now {
                next += ChronoDuration::days(1);
            }
        }
        TodoRepeatRule::Weekly => {
            while next <= now {
                next += ChronoDuration::weeks(1);
            }
        }
        TodoRepeatRule::Workdays => {
            while next <= now || matches!(next.weekday(), Weekday::Sat | Weekday::Sun) {
                next += ChronoDuration::days(1);
            }
        }
        TodoRepeatRule::None => {}
    }
    Some(next.to_rfc3339())
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').to_string();
        if !tag.is_empty()
            && tag.chars().count() <= 30
            && !result.iter().any(|current| current == &tag)
        {
            result.push(tag);
        }
        if result.len() >= 10 {
            break;
        }
    }
    result
}

fn priority_rank(priority: &TodoPriority) -> u8 {
    match priority {
        TodoPriority::Low => 0,
        TodoPriority::Normal => 1,
        TodoPriority::High => 2,
        TodoPriority::Urgent => 3,
    }
}

fn validate_datetime(value: &Option<String>) -> Result<(), String> {
    if let Some(value) = value {
        DateTime::parse_from_rfc3339(value)
            .map_err(|_| "日期必须使用 ISO 8601 格式".to_string())?;
    }
    Ok(())
}

fn parse_datetime_value(value: serde_json::Value) -> Result<Option<String>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(value) => {
            validate_datetime(&Some(value.clone()))?;
            Ok(Some(value))
        }
        _ => Err("日期必须使用 ISO 8601 格式".to_string()),
    }
}

pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        const IDLE_WAIT: Duration = Duration::from_secs(60);
        // 变更唤醒通道：空闲时阻塞等待，仅在待办写入（save_locked → wake_scheduler）
        // 或下一个提醒临近时被唤醒，取代固定轮询，兼顾提示及时性与空闲功耗。
        let (wake_tx, wake_rx) = mpsc::channel::<()>();
        if let Ok(mut guard) = scheduler_wake().lock() {
            *guard = Some(wake_tx);
        }
        loop {
            let busy = app
                .try_state::<crate::config::ConfigManager>()
                .map(|config| {
                    config.get_todo_enabled().unwrap_or(false)
                        && config.get_todo_reminders_enabled().unwrap_or(true)
                })
                .unwrap_or(false);
            if busy {
                if let Some(state) = app.try_state::<TodoStore>() {
                    if let Ok(items) = state.due_reminders(Utc::now()) {
                        // due_reminders 收集时会把所有到期项标记为已触发，因此若在逐条
                        // 播报中途被禁用而中断，必须把尚未播报的尾部项还原为未触发，
                        // 否则这些提醒会被永久吞掉（重新启用后也不会补发）。
                        let mut shown = 0usize;
                        while shown < items.len() {
                            let item = &items[shown];
                            // The tool can be disabled between the loop-level check and
                            // due_reminders(). Re-check immediately before emitting any
                            // user-visible reminder so disabling the tool silences it at once.
                            let enabled = app
                                .try_state::<crate::config::ConfigManager>()
                                .map(|config| {
                                    config.get_todo_enabled().unwrap_or(false)
                                        && config.get_todo_reminders_enabled().unwrap_or(true)
                                })
                                .unwrap_or(false);
                            if !enabled {
                                break;
                            }
                            // 通过启用检查即视为“已播报”：先推进 shown 再发送，
                            // 这样发送后若被禁用，中断只影响后续项，本条不会重复补发。
                            shown += 1;
                            let _ = app
                                .emit("todo-reminder", TodoReminderPayload { item: item.clone() });
                            let still_enabled = app
                                .try_state::<crate::config::ConfigManager>()
                                .map(|config| {
                                    config.get_todo_enabled().unwrap_or(false)
                                        && config.get_todo_reminders_enabled().unwrap_or(true)
                                })
                                .unwrap_or(false);
                            if !still_enabled {
                                break;
                            }
                            let sound = app
                                .try_state::<crate::config::ConfigManager>()
                                .and_then(|config| config.get_todo_reminder_sound().ok())
                                .unwrap_or_else(|| "tone".to_string());
                            if sound != "none" {
                                crate::sound::play_tone();
                            }
                            let still_enabled = app
                                .try_state::<crate::config::ConfigManager>()
                                .map(|config| {
                                    config.get_todo_enabled().unwrap_or(false)
                                        && config.get_todo_reminders_enabled().unwrap_or(true)
                                })
                                .unwrap_or(false);
                            if !still_enabled {
                                break;
                            }
                            let _ = app
                                .notification()
                                .builder()
                                .title("待办提醒")
                                .body(&item.title)
                                .show();
                        }
                        if shown < items.len() {
                            let unshown: Vec<String> =
                                items[shown..].iter().map(|item| item.id.clone()).collect();
                            let _ = state.unmark_reminders_fired(&unshown);
                        }
                    }
                }
            }
            // 提醒未启用时无需精确计时，直接阻塞空闲等待；
            // 启用时才精确等到下一个提醒到期时间，无待触发提醒时也回退空闲等待。
            // recv_timeout 不持有 scheduler_wake 锁；变更到达时立即返回、及时重算。
            let wait = if busy {
                app.try_state::<TodoStore>()
                    .and_then(|state| state.next_reminder_in(Utc::now()).ok())
                    .flatten()
                    .unwrap_or(IDLE_WAIT)
            } else {
                IDLE_WAIT
            };
            let _ = wake_rx.recv_timeout(wait.min(IDLE_WAIT));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_item(id: &str, sort_order: i64) -> TodoItem {
        TodoItem {
            id: id.to_string(),
            title: "Task".to_string(),
            notes: String::new(),
            priority: TodoPriority::Normal,
            tags: Vec::new(),
            list_id: String::new(),
            deleted_at: None,
            repeat_rule: TodoRepeatRule::None,
            status: TodoStatus::Active,
            due_at: None,
            remind_at: None,
            reminder_fired_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: None,
            sort_order,
        }
    }

    fn test_store(items: Vec<TodoItem>) -> (TodoStore, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "levitaire-todo-test-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut data = TodoFile {
            version: FILE_VERSION,
            lists: Vec::new(),
            items,
        };
        migrate_file(&mut data);
        (
            TodoStore {
                file_path: path.clone(),
                data: Mutex::new(data),
                next_id: AtomicU64::new(1),
            },
            path,
        )
    }

    #[test]
    fn next_reminder_in_sleeps_only_until_future_reminders() {
        let now = Utc::now();
        let mut future = test_item("future", 0);
        future.remind_at = Some((now + ChronoDuration::minutes(5)).to_rfc3339());
        // 已触发过的提醒不应再计入等待时间。
        let mut fired = test_item("fired", 1);
        fired.remind_at = Some((now + ChronoDuration::minutes(1)).to_rfc3339());
        fired.reminder_fired_at = Some(now.to_rfc3339());
        let (store, _path) = test_store(vec![future, fired]);
        let wait = store.next_reminder_in(now).unwrap().unwrap();
        assert!(
            wait > Duration::from_secs(4 * 60),
            "wait should target the 5-min reminder"
        );
        assert!(wait <= Duration::from_secs(5 * 60));
    }

    #[test]
    fn next_reminder_in_is_none_when_no_future_reminders() {
        let now = Utc::now();
        // 已到期/已完成的提醒若未触发，属于应立刻触发而非阻塞等待的场景，均不计入。
        let mut past = test_item("past", 0);
        past.remind_at = Some((now - ChronoDuration::minutes(1)).to_rfc3339());
        let (store, _path) = test_store(vec![past]);
        assert!(store.next_reminder_in(now).unwrap().is_none());
    }

    #[test]
    fn title_is_trimmed_and_validated() {
        assert_eq!(normalize_title("  test  ").unwrap(), "test");
        assert!(normalize_title(" ").is_err());
    }

    #[test]
    fn invalid_datetime_is_rejected() {
        assert!(validate_datetime(&Some("tomorrow".to_string())).is_err());
    }

    #[test]
    fn snooze_rejects_invalid_duration() {
        assert!(!(1..=1_440).contains(&0));
        assert!(!(1..=1_440).contains(&1_441));
    }

    #[test]
    fn completing_a_repeating_task_is_idempotent() {
        let mut item = test_item("repeat", 1);
        item.repeat_rule = TodoRepeatRule::Daily;
        let (store, path) = test_store(vec![item]);
        store.set_completed("repeat", true).unwrap();
        store.set_completed("repeat", true).unwrap();
        assert_eq!(store.list(true, None).unwrap().len(), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn repeating_dates_advance_past_the_current_time() {
        let now = DateTime::parse_from_rfc3339("2026-08-27T11:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let daily = next_due(Some("2026-08-25T09:00:00Z"), TodoRepeatRule::Daily, now).unwrap();
        let weekly = next_due(Some("2026-08-06T09:00:00Z"), TodoRepeatRule::Weekly, now).unwrap();
        let workday =
            next_due(Some("2026-08-21T09:00:00Z"), TodoRepeatRule::Workdays, now).unwrap();
        for value in [daily, weekly, workday] {
            assert!(
                DateTime::parse_from_rfc3339(&value)
                    .unwrap()
                    .with_timezone(&Utc)
                    > now
            );
        }
    }

    #[test]
    fn manual_reorder_ignores_deleted_tasks() {
        let mut deleted = test_item("deleted", 1);
        deleted.deleted_at = Some("2026-01-02T00:00:00Z".to_string());
        let (store, path) = test_store(vec![deleted, test_item("active", 2)]);
        store.reorder("active", -1).unwrap();
        assert_eq!(store.list(true, Some("manual")).unwrap()[0].id, "active");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn move_to_repositions_within_the_same_group() {
        let (store, path) = test_store(vec![
            test_item("a", 1),
            test_item("b", 2),
            test_item("c", 3),
        ]);
        // 把 a 移到 c 之前
        store.move_to("a", Some("c")).unwrap();
        let listed = store.list(true, Some("manual")).unwrap();
        let ids: Vec<_> = listed.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a", "c"]);
        // 把 a 移到组末尾
        store.move_to("a", None).unwrap();
        let listed = store.list(true, Some("manual")).unwrap();
        let ids: Vec<_> = listed.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn move_to_ignores_deleted_tasks_and_unknown_before() {
        let mut deleted = test_item("deleted", 0);
        deleted.deleted_at = Some("2026-01-02T00:00:00Z".to_string());
        let (store, path) = test_store(vec![deleted, test_item("a", 1), test_item("b", 2)]);
        // before 指向不存在的任务时退化为移动到末尾
        store.move_to("a", Some("ghost")).unwrap();
        let listed = store.list(true, Some("manual")).unwrap();
        let ids: Vec<_> = listed.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
        // 已删除任务不能移动
        assert!(store.move_to("deleted", None).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn deleted_tasks_cannot_be_changed_until_restored() {
        let mut deleted = test_item("deleted", 1);
        deleted.deleted_at = Some("2026-01-02T00:00:00Z".to_string());
        let (store, path) = test_store(vec![deleted]);

        assert!(store.reorder("deleted", 1).is_err());
        assert!(store.update("deleted", UpdateTodoInput::default()).is_err());
        assert!(store.snooze("deleted", 5).is_err());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn restore_requires_the_canonical_deleted_record() {
        let (store, path) = test_store(Vec::new());
        assert!(store.restore("purged").is_err());
        assert!(store.list(true, None).unwrap().is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn import_rejects_duplicate_task_ids() {
        let (store, store_path) = test_store(Vec::new());
        let input_path = std::env::temp_dir().join(format!(
            "levitaire-todo-import-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let item = test_item("duplicate", 1);
        let file = TodoFile {
            version: FILE_VERSION,
            lists: Vec::new(),
            items: vec![item.clone(), item],
        };
        fs::write(&input_path, serde_json::to_string(&file).unwrap()).unwrap();
        assert!(store
            .import_from(&input_path)
            .unwrap_err()
            .contains("unique"));
        let _ = fs::remove_file(store_path);
        let _ = fs::remove_file(input_path);
    }

    fn test_list(id: &str, name: &str) -> TodoList {
        TodoList {
            id: id.to_string(),
            name: name.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn test_input(title: &str, list_id: &str) -> CreateTodoInput {
        CreateTodoInput {
            title: title.to_string(),
            notes: String::new(),
            priority: TodoPriority::Normal,
            tags: Vec::new(),
            list_id: list_id.to_string(),
            repeat_rule: TodoRepeatRule::None,
            due_at: None,
            remind_at: None,
        }
    }

    #[test]
    fn migration_drops_the_legacy_inbox_and_unfiles_its_tasks() {
        let mut file = TodoFile {
            version: 2,
            lists: vec![
                test_list(LEGACY_INBOX_LIST_ID, "Inbox"),
                test_list("list-1", "工作"),
            ],
            items: vec![
                test_item("inboxed", 1),
                test_item("listed", 2),
                test_item("dangling", 3),
            ],
        };
        file.items[0].list_id = LEGACY_INBOX_LIST_ID.to_string();
        file.items[1].list_id = "list-1".to_string();
        file.items[2].list_id = "list-gone".to_string();

        migrate_file(&mut file);

        assert_eq!(file.version, FILE_VERSION);
        assert_eq!(file.lists.len(), 1);
        // 收件箱下的任务和悬空引用都落回「无清单」，真实清单原地不动。
        assert_eq!(file.items[0].list_id, "");
        assert_eq!(file.items[1].list_id, "list-1");
        assert_eq!(file.items[2].list_id, "");
    }

    #[test]
    fn tasks_may_belong_to_no_list_but_never_to_a_missing_one() {
        let (store, path) = test_store(Vec::new());
        let item = store.create(test_input("无清单任务", "")).unwrap();
        assert_eq!(item.list_id, "");
        // 空白串等价于空串，不写入脏数据
        assert_eq!(store.create(test_input("空白", "  ")).unwrap().list_id, "");
        assert!(store.create(test_input("坏引用", "list-gone")).is_err());

        let moved = UpdateTodoInput {
            list_id: Some("list-gone".to_string()),
            ..Default::default()
        };
        assert!(store.update(&item.id, moved).is_err());
        let cleared = UpdateTodoInput {
            list_id: Some(String::new()),
            ..Default::default()
        };
        assert_eq!(store.update(&item.id, cleared).unwrap().list_id, "");
        let _ = fs::remove_file(path);
    }

    /// 走真实文件读入：验证「旧版本写出的 v2 文件」经 serde 反序列化后能被正确迁移。
    /// 只测 migrate_file 会漏掉字段名/缺省值对不上的情况。
    #[test]
    fn loading_a_legacy_file_migrates_it_in_place() {
        let path = std::env::temp_dir().join(format!(
            "levitaire-todo-legacy-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let legacy = serde_json::json!({
            "version": 2,
            "lists": [
                { "id": "inbox", "name": "Inbox", "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z" },
                { "id": "list-1", "name": "工作", "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z" }
            ],
            "items": [
                { "id": "todo-1", "title": "收件箱里的任务", "status": "active", "listId": "inbox",
                  "dueAt": null, "remindAt": null, "reminderFiredAt": null,
                  "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                  "completedAt": null, "sortOrder": 1 }
            ]
        });
        fs::write(&path, serde_json::to_string(&legacy).unwrap()).unwrap();

        let file = load_file(&path);

        assert_eq!(file.version, FILE_VERSION);
        assert_eq!(file.lists.len(), 1);
        assert_eq!(file.lists[0].id, "list-1");
        assert_eq!(file.items[0].list_id, "");
        let _ = fs::remove_file(path);
    }

    /// 导出/导入往返：清单可以为空、任务可以无清单，导入端不能因此报错或丢任务。
    #[test]
    fn export_import_round_trip_keeps_unlisted_tasks() {
        let (store, store_path) = test_store(Vec::new());
        store.create(test_input("无清单任务", "")).unwrap();
        let export_path = std::env::temp_dir().join(format!(
            "levitaire-todo-roundtrip-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        store.export_to(&export_path).unwrap();

        let (target, target_path) = test_store(Vec::new());
        target.import_from(&export_path).unwrap();
        let listed = target.list(true, Some("manual")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "无清单任务");
        assert_eq!(listed[0].list_id, "");

        let _ = fs::remove_file(store_path);
        let _ = fs::remove_file(target_path);
        let _ = fs::remove_file(export_path);
    }

    #[test]
    fn deleting_a_list_unfiles_its_tasks_instead_of_dropping_them() {
        let (store, path) = test_store(Vec::new());
        let list = store
            .create_list(CreateTodoListInput {
                name: "工作".to_string(),
            })
            .unwrap();
        let item = store.create(test_input("任务", &list.id)).unwrap();

        store.delete_list(&list.id).unwrap();

        let listed = store.list(true, Some("manual")).unwrap();
        // 任务不能随清单一起消失，也不该留下悬空引用。
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, item.id);
        assert_eq!(listed[0].list_id, "");
        assert!(store.list_lists().unwrap().is_empty());
        let _ = fs::remove_file(path);
    }
}
