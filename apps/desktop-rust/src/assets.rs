use gpui_kit::{AssetSource, Result, SharedString};
use std::borrow::Cow;

gpui_kit::assets::icon_assets!(
    WorkspaceIcons,
    [Files, Clock, Tags, Trash, FolderPlus, Import]
);

gpui_kit::assets::icon_assets!(
    EditorIcons,
    [
        ArrowDown,
        ArrowLeft,
        Bold,
        BookOpen,
        BookOpenText,
        ChevronDown,
        ChevronUp,
        ClipboardCheck,
        Code,
        Columns2,
        Copy,
        Download,
        Expand,
        FileCode,
        FileDiff,
        FilePen,
        FilePlus,
        FileText,
        GripVertical,
        Hash,
        Heading1,
        Heading2,
        Heading3,
        Heading4,
        Heading5,
        Heading6,
        Image,
        Italic,
        Link,
        List,
        ListIndentDecrease,
        ListIndentIncrease,
        ListOrdered,
        ListTodo,
        MessageSquare,
        Minus,
        Network,
        NotebookPen,
        PanelTopOpen,
        Pilcrow,
        Play,
        Plus,
        Presentation,
        Quote,
        Redo2,
        RefreshCw,
        Rows2,
        Save,
        SaveAll,
        Scaling,
        Search,
        Settings,
        SquareCode,
        SquarePen,
        Strikethrough,
        Table,
        TableColumnsSplit,
        TableRowsSplit,
        Target,
        TextWrap,
        Undo2,
        Video,
        X
    ]
);

pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match WorkspaceIcons.load(path)? {
            Some(bytes) => Ok(Some(bytes)),
            None => match EditorIcons.load(path)? {
                Some(bytes) => Ok(Some(bytes)),
                None => gpui_kit::assets::Assets.load(path),
            },
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(WorkspaceIcons.list(path)?);
        paths.extend(EditorIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
