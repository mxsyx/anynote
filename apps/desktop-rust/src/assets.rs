use gpui_kit::{AssetSource, Result, SharedString};
use std::borrow::Cow;

gpui_kit::assets::icon_assets!(
    WorkspaceIcons,
    [Files, Clock, Tags, Trash, FolderPlus, Import]
);

pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match WorkspaceIcons.load(path)? {
            Some(bytes) => Ok(Some(bytes)),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(WorkspaceIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
