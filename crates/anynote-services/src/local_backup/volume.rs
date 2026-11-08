//! Native volume facts and deterministic mount fixtures. Device IDs are not physical-disk proof.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub filesystem: String,
    pub device_id: String,
    pub volume_uuid: Option<String>,
    pub mount_point: PathBuf,
    pub available_bytes: u64,
    pub remote: bool,
    pub maximum_file_bytes: Option<u64>,
}
impl VolumeInfo {
    pub fn require_local(&self, largest: u64, needed: u64) -> Result<()> {
        require(
            !self.remote,
            "UNSUPPORTED_FILESYSTEM",
            "不支持网络或云盘挂载",
        )?;
        require(
            self.maximum_file_bytes.is_none_or(|n| largest <= n),
            "UNSUPPORTED_FILESYSTEM",
            "目标单文件大小限制不足",
        )?;
        require(
            self.available_bytes >= needed,
            "NO_SPACE",
            "备份磁盘空间不足",
        )
    }
    pub fn same_volume(&self, other: &Self) -> bool {
        self.device_id == other.device_id && self.volume_uuid == other.volume_uuid
    }
}
pub trait VolumeProbe {
    fn inspect(&self, path: &Path) -> Result<VolumeInfo>;
}
pub struct NativeVolumes;
impl VolumeProbe for NativeVolumes {
    fn inspect(&self, path: &Path) -> Result<VolumeInfo> {
        native(path)
    }
}
fn maximum(fs: &str) -> Option<u64> {
    matches!(
        fs.to_ascii_lowercase().as_str(),
        "fat" | "fat32" | "vfat" | "msdos"
    )
    .then_some(u32::MAX as u64)
}
fn remote(fs: &str) -> bool {
    matches!(
        fs,
        "nfs" | "nfs4" | "cifs" | "smbfs" | "smb3" | "9p" | "afs" | "davfs" | "davfs2"
    ) || fs.starts_with("fuse.")
}
fn unescape(s: &str) -> String {
    s.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}
pub fn linux_mountinfo(text: &str, path: &Path, available_bytes: u64) -> Result<VolumeInfo> {
    text.lines()
        .filter_map(|line| {
            let (left, right) = line.split_once(" - ")?;
            let fields: Vec<_> = left.split_whitespace().collect();
            let fs = right.split_whitespace().next()?;
            let mount = PathBuf::from(unescape(fields.get(4)?));
            if !path.starts_with(&mount) {
                return None;
            }
            Some(VolumeInfo {
                filesystem: fs.into(),
                device_id: fields.get(2)?.to_string(),
                volume_uuid: None,
                mount_point: mount,
                available_bytes,
                remote: remote(fs),
                maximum_file_bytes: maximum(fs),
            })
        })
        .max_by_key(|v| v.mount_point.components().count())
        .ok_or_else(|| Error::new("VOLUME_UNKNOWN", "无法确定目标挂载点"))
}
/// Shared interpretation for the Windows API adapter and fixtures (DRIVE_REMOTE = 4).
pub fn windows_volume(
    filesystem: &str,
    guid: &str,
    serial: u32,
    drive_type: u32,
    mount: PathBuf,
    available_bytes: u64,
) -> Result<VolumeInfo> {
    require(drive_type >= 2, "TARGET_OFFLINE", "等待磁盘连接")?;
    Ok(VolumeInfo {
        filesystem: filesystem.into(),
        device_id: serial.to_string(),
        volume_uuid: (!guid.is_empty()).then(|| guid.into()),
        mount_point: mount,
        available_bytes,
        remote: drive_type == 4,
        maximum_file_bytes: maximum(filesystem),
    })
}
#[cfg(unix)]
#[allow(unsafe_code, clippy::unnecessary_cast)]
fn free_bytes(path: &Path) -> Result<u64> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::new("PATH_UNSAFE", "路径包含 NUL"))?;
    let mut value = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // The initialized C string and output storage remain alive for the syscall.
    if unsafe { libc::statvfs(path.as_ptr(), value.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let value = unsafe { value.assume_init() };
    Ok((value.f_bavail as u64).saturating_mul(value.f_frsize as u64))
}
#[cfg(target_os = "linux")]
fn native(path: &Path) -> Result<VolumeInfo> {
    let path = fs::canonicalize(path)?;
    let mut info = linux_mountinfo(
        &fs::read_to_string("/proc/self/mountinfo")?,
        &path,
        free_bytes(&path)?,
    )?;
    let device = PathBuf::from("/dev/block").join(&info.device_id);
    if let Ok(device) = fs::canonicalize(device)
        && let Ok(entries) = fs::read_dir("/dev/disk/by-uuid")
    {
        for entry in entries.flatten() {
            if fs::canonicalize(entry.path()).ok().as_ref() == Some(&device) {
                info.volume_uuid = entry.file_name().into_string().ok();
                break;
            }
        }
    }
    Ok(info)
}
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn native(path: &Path) -> Result<VolumeInfo> {
    use std::{
        ffi::{CStr, CString},
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
    };
    let p = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::new("PATH_UNSAFE", "路径包含 NUL"))?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::statfs(p.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stat = unsafe { stat.assume_init() };
    let filesystem = unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    let mount = unsafe { CStr::from_ptr(stat.f_mntonname.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    let mut attributes = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mount_c =
        CString::new(mount.as_bytes()).map_err(|_| Error::new("PATH_UNSAFE", "挂载点包含 NUL"))?;
    let mut uuid_bytes = [0u8; 20];
    // ATTR_VOL_UUID returns a length-prefixed 16-byte UUID; unsupported filesystems keep the weaker identity.
    let volume_uuid = if unsafe {
        libc::getattrlist(
            mount_c.as_ptr(),
            (&mut attributes as *mut libc::attrlist).cast(),
            uuid_bytes.as_mut_ptr().cast(),
            uuid_bytes.len(),
            libc::FSOPT_NOFOLLOW,
        )
    } == 0
    {
        macos_volume_uuid(&uuid_bytes)
    } else {
        None
    };
    Ok(VolumeInfo {
        remote: remote(&filesystem),
        maximum_file_bytes: maximum(&filesystem),
        filesystem,
        device_id: fs::metadata(path)?.dev().to_string(),
        volume_uuid,
        mount_point: mount.into(),
        available_bytes: free_bytes(path)?,
    })
}
#[cfg(windows)]
#[allow(unsafe_code)]
fn native(path: &Path) -> Result<VolumeInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{Win32::Storage::FileSystem::*, core::PCWSTR};
    let p: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut mount = vec![0u16; 32768];
    let mut guid = vec![0u16; 128];
    let mut filesystem = vec![0u16; 256];
    let mut serial = 0;
    let mut available = 0;
    let err = |e: windows::core::Error| Error::new("VOLUME_UNKNOWN", e.to_string());
    let drive_type;
    // All buffers are owned, terminated and live throughout the synchronous API calls.
    unsafe {
        GetVolumePathNameW(PCWSTR(p.as_ptr()), &mut mount).map_err(err)?;
        GetDiskFreeSpaceExW(PCWSTR(p.as_ptr()), Some(&mut available), None, None).map_err(err)?;
        GetVolumeInformationW(
            PCWSTR(mount.as_ptr()),
            None,
            Some(&mut serial),
            None,
            None,
            Some(&mut filesystem),
        )
        .map_err(err)?;
        drive_type = GetDriveTypeW(PCWSTR(mount.as_ptr()));
        if drive_type != 4 {
            GetVolumeNameForVolumeMountPointW(PCWSTR(mount.as_ptr()), &mut guid).map_err(err)?;
        }
    }
    let text = |v: &[u16]| {
        String::from_utf16_lossy(&v[..v.iter().position(|&c| c == 0).unwrap_or(v.len())])
    };
    windows_volume(
        &text(&filesystem),
        &text(&guid),
        serial,
        drive_type,
        text(&mount).into(),
        available,
    )
}

/// Decode the fixed ATTR_VOL_UUID response without claiming a UUID when the filesystem omits it.
pub fn macos_volume_uuid(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 20 || u32::from_ne_bytes(bytes[..4].try_into().ok()?) != 20 {
        return None;
    }
    let id = uuid::Uuid::from_bytes(bytes[4..].try_into().ok()?);
    (!id.is_nil()).then(|| id.to_string())
}
