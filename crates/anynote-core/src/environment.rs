//! Unknown platform observations must not silently become permission to start background work.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Environment {
    on_battery: Option<bool>,
    online: Option<bool>,
    metered: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvironmentEvent {
    PowerChanged(Option<bool>),
    NetworkChanged {
        online: Option<bool>,
        metered: Option<bool>,
    },
    Resumed,
}

impl Environment {
    pub fn on_battery(&self) -> Option<bool> {
        self.on_battery
    }
    pub fn online(&self) -> Option<bool> {
        self.online
    }
    pub fn metered(&self) -> Option<bool> {
        self.metered
    }

    pub fn apply(&mut self, event: EnvironmentEvent) {
        match event {
            EnvironmentEvent::PowerChanged(value) => self.on_battery = value,
            EnvironmentEvent::NetworkChanged { online, metered } => {
                self.online = online;
                self.metered = metered;
            }
            EnvironmentEvent::Resumed => *self = Self::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_invalidates_pre_sleep_observations() {
        let mut environment = Environment::default();
        environment.apply(EnvironmentEvent::PowerChanged(Some(false)));
        environment.apply(EnvironmentEvent::NetworkChanged {
            online: Some(true),
            metered: Some(false),
        });
        assert_eq!(environment.online(), Some(true));
        environment.apply(EnvironmentEvent::Resumed);
        assert_eq!(environment, Environment::default());
        assert_eq!(environment.on_battery(), None);
    }
}
