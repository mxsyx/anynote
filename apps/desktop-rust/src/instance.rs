#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
use interprocess::local_socket::{ListenerOptions, Name, Stream, prelude::*};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

pub enum Instance {
    Primary(InstanceGuard, async_channel::Receiver<()>),
    Activated,
}

pub struct InstanceGuard {
    _lock: File,
    name: Name<'static>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

fn socket_name(directory: &Path) -> io::Result<Name<'static>> {
    #[cfg(unix)]
    return directory
        .join("desktop.instance.sock")
        .to_fs_name::<GenericFilePath>()
        .map(Name::into_owned);
    #[cfg(windows)]
    {
        use interprocess::local_socket::GenericNamespaced;
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        directory.hash(&mut hash);
        format!("anynote.desktop.{:x}", hash.finish())
            .to_ns_name::<GenericNamespaced>()
            .map(Name::into_owned)
    }
}

pub fn acquire(directory: &Path) -> io::Result<Instance> {
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let directory = fs::canonicalize(directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("desktop.instance.lock"))?;
    let name = socket_name(&directory)?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            // The owner may still be between acquiring its lock and binding its socket.
            for _ in 0..50 {
                if Stream::connect(name.clone()).is_ok() {
                    return Ok(Instance::Activated);
                }
                thread::sleep(Duration::from_millis(20));
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "running instance did not accept activation",
            ));
        }
        Err(std::fs::TryLockError::Error(error)) => return Err(error),
    }
    // Only the lock owner can remove a socket left behind by a killed process.
    #[cfg(unix)]
    match fs::remove_file(directory.join("desktop.instance.sock")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = ListenerOptions::new().name(name.clone()).create_sync()?;
    let (sender, receiver) = async_channel::bounded(1);
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_stopping = stopping.clone();
    let worker = thread::Builder::new()
        .name("desktop-activation".into())
        .spawn(move || {
            for connection in listener.incoming() {
                if worker_stopping.load(Ordering::Acquire) || connection.is_err() {
                    break;
                }
                // Connection alone means activate: no peer-controlled allocation or blocking read.
                let _ = sender.try_send(());
            }
        })?;
    Ok(Instance::Primary(
        InstanceGuard {
            _lock: lock,
            name,
            stopping,
            worker: Some(worker),
        },
        receiver,
    ))
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = Stream::connect(self.name.clone());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
