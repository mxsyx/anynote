//! Scheduling permission is separate from starting a service task.
use anynote_core::environment::Environment;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleDecision {
    Ready,
    WaitingForObservation,
    WaitingForNetwork,
    WaitingForPower,
    WaitingForUnmetered,
}
pub fn background_decision(environment: &Environment) -> ScheduleDecision {
    match (
        environment.online(),
        environment.on_battery(),
        environment.metered(),
    ) {
        (Some(false), _, _) => ScheduleDecision::WaitingForNetwork,
        (_, Some(true), _) => ScheduleDecision::WaitingForPower,
        (_, _, Some(true)) => ScheduleDecision::WaitingForUnmetered,
        (Some(true), Some(false), Some(false)) => ScheduleDecision::Ready,
        _ => ScheduleDecision::WaitingForObservation,
    }
}
