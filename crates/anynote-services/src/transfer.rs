//! Cross-notebook protocol, serialized with ordinary writes on the storage queue.
pub use anynote_storage::notebook::transfer::{
    TransferMode, TransferRequest, TransferResult, TransferStatus,
};
use anynote_storage::notebook::{ReadResult, WriteQueue, WriteTicket};

pub fn transfer_node(
    queue: &WriteQueue,
    request: TransferRequest,
) -> ReadResult<WriteTicket<TransferResult>> {
    request.validate()?;
    queue.submit(move |catalog| {
        catalog.with_pair(
            &request.notebook_id,
            &request.target_notebook_id,
            |source, target| {
                if let Some(result) = source.completed_transfer(&request)? {
                    return Ok(result);
                }
                let copied = target.copy_transfer(source, &request)?;
                if request.mode == TransferMode::Copy {
                    return Ok(copied.result());
                }
                source.finish_transfer_move(target, &request, &copied)
            },
        )
    })
}
