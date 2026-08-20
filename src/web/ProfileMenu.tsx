import { useEffect, useRef, useState } from "preact/hooks";
import { normalizeDisplayName } from "../shared/display-name";

export function ProfileMenu({
  displayName,
  initiallyOpen = false,
  onSave,
}: {
  displayName: string;
  initiallyOpen?: boolean;
  onSave(displayName: string): void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [draft, setDraft] = useState(displayName);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setDraft(displayName);
  }, [displayName, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.show();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeWhenRequested = (event: KeyboardEvent | PointerEvent) => {
      const dialog = dialogRef.current;
      if (dialog === null || !dialog.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        dialog.close();
        return;
      }
      const target = event.target;
      if (
        target instanceof Node &&
        !dialog.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        dialog.close();
      }
    };
    document.addEventListener("keydown", closeWhenRequested);
    document.addEventListener("pointerdown", closeWhenRequested);
    return () => {
      document.removeEventListener("keydown", closeWhenRequested);
      document.removeEventListener("pointerdown", closeWhenRequested);
    };
  }, [open]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const close = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else setOpen(false);
  };

  return (
    <div class="profile-menu">
      <button
        ref={triggerRef}
        class="profile-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`编辑昵称，当前为${displayName}`}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setDraft(displayName);
          setError(null);
          setNotice(null);
          setOpen(true);
        }}
      >
        <span class="profile-trigger-name">{displayName}</span>
        <span class="profile-edit-mark" aria-hidden="true">✎</span>
      </button>

      <dialog
        ref={dialogRef}
        class="profile-dialog"
        aria-labelledby="profile-dialog-title"
        onCancel={() => setOpen(false)}
        onClose={() => {
          setOpen(false);
          setError(null);
          triggerRef.current?.focus();
        }}
      >
        <header class="dialog-heading">
          <div>
            <p class="eyebrow">游客资料</p>
            <h2 id="profile-dialog-title">修改昵称</h2>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label="关闭昵称设置"
            onClick={close}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <form
          class="profile-editor"
          onSubmit={(event) => {
            event.preventDefault();
            const normalized = normalizeDisplayName(draft);
            if (normalized === null) {
              setError("昵称需为 1–16 个字符，且不能包含控制字符。");
              return;
            }
            setDraft(normalized);
            onSave(normalized);
            setNotice("昵称已保存");
            close();
          }}
        >
          <label for="profile-display-name">你的昵称</label>
          <input
            id="profile-display-name"
            name="displayName"
            value={draft}
            autocomplete="nickname"
            autofocus
            aria-describedby="profile-display-name-help profile-display-name-error"
            onInput={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
          />
          <small id="profile-display-name-help">
            1–16 个字符，保存在此浏览器
          </small>
          <p
            id="profile-display-name-error"
            class="profile-error"
            role={error === null ? undefined : "alert"}
          >
            {error}
          </p>
          <button class="primary-button" type="submit">保存昵称</button>
        </form>
      </dialog>
      {notice && (
        <span class="profile-notice" role="status">{notice}</span>
      )}
    </div>
  );
}
