# 24. Attachments are kept in the assistant's database, and images reach the model only where a room lets them

People want to send the assistant a photo of a receipt, a screenshot or a PDF, as they would a friend. Protocol v1 had text messages only. Redaction (ADR 2) reads text, so an image would reach the provider with whatever it shows: faces, addresses, card numbers. ADR 12 kept images from MCP servers out for that reason and listed options for later. A file has the same problem whenever its text isn't read first.

**An attachment is uploaded first, then sent with a message.** `POST /rooms/<id>/attachments?name=<file>` takes the bytes as the body, with their type as `Content-Type`, up to `ATTACHMENT_MAX_BYTES` (10 MiB), and answers an `Attachment`: `a1`, `a2`, … within the room, its name, type, size and `kind` (`image` for PNG, JPEG, GIF and WebP, which providers take; `file` for everything else). A message names up to `ATTACHMENTS_PER_MESSAGE` (8) of them in `attachments`, and may then have no text. Only the uploader can send an attachment, and only once. Resending with the same request id still works. An attachment nobody sent within a day is dropped the next time someone uploads to the room. Clients scale photos down to 2048 pixels on the long side before uploading, as providers do anyway.

**The bytes are kept in the assistant's own storage.** The index is one document per room, and the bytes are split into chunks of 192 KiB (256 KiB as base64), one document each, stored whole (`checkpointWhen`). That puts them in the encrypted database (ADR 7) and its backups (ADR 8) without a second key to keep. It works where there is no file system, as on a Durable Object, whose values are limited to 2 MB. With `secure_delete`, removing one leaves no copy in free pages. A room holds at most 256 MiB.

**Attachments are seen as their message is.** Every member of the room may download one that was sent (`GET /rooms/<id>/attachments/<aN>`). One sent in a private message is its author's alone, like the message's text (ADR 9). One not sent yet is its uploader's alone. The file name counts as text: once sent, it is stored with placeholders, owned by the author when the message is private, and shown to each person as their viewer allows. Downloads are served with `nosniff` and a sandboxing CSP, and only the four image types are served inline, so an uploaded HTML or SVG file can't run in the web app's origin. The uploader or an admin can remove an attachment (`DELETE`). Its bytes are gone at once, and it answers 410 from then on. The model and tools no longer get it, and the timeline keeps its name so people know there was one.

**The model gets a line for each attachment, and the image itself only where the room lets it.** The message the model reads ends with `[attachment a3: receipt.jpg, image/jpeg, 240 KB]` for each one. For an image it also holds an image part that refers to the attachment and carries no bytes. `RedactingModels`, which every request passes through, compaction and code mode included, fills that part in just before the request goes out, or else puts a line saying why it isn't shown. It fills it in only when all of these hold:

- the room's `imagesToModel` is on;
- the attachment is still there;
- it is at most 5 MB.

Because this is decided per request rather than when the message was sent, turning the setting off or removing an attachment takes effect from the next request. Images sent earlier don't stay in the context. The reference can't be forged: only `Nudge.submit` builds image parts. Text a person types, a nudge or a tool's output stays text, so naming `a5` in a message never brings in someone else's private photo.

**Sending images is a room's choice, made by people.** `PUT /rooms/<id>/images {allowed}` turns it on or off. Anyone in the room may change it, as with the room's extensions, and never the model. The room shows `imagesToModel`, so everyone there knows their photos go to the provider as they are. It is off by default. Image redaction isn't solved by this. It is consent, which ADR 12 found the least work and the weakest option, but the one that works with any provider today. Rooms without it still get the attachment's line, so the model knows there is one and can say what it can't see. The local options ADR 12 lists stay open behind the same part: reading the text with OCR, or describing the image with a local model, then redacting that text. Either one could fill in the part with text in place of the picture, for rooms that keep images from the provider.

**Extensions reach attachments through the assistant, as the person their turn acts for.** `Nudge.attachments` reads one by room and id, and only if `actingFor` (ADR 9) may see it. Through it:

- the documents extension can file an attachment as a document, with its text read on the host (`save_attachment`);
- the terminal can copy one to `/workspace/attachments/` (`attachment_to_workspace`);
- mail can send one with a message, through its usual approval (`mail_send`'s `attachments`, read when it is approved, as whoever asked may see it).

Documents and the workspace are the whole room's, so neither takes an attachment that was sent privately.

The clients' pickers and previews come after the protocol and the server. This ADR settles the shapes they build on.

What this doesn't do: files' text isn't given to the model on its own. A text file or a PDF reaches it only through a tool, such as the documents extension, which reads and redacts it. Attachments from other assistants, from chat bridges, or in mail the assistant reads are not attachments in this sense; they stay with the extensions that bring them. There is no virus scanning. Like redaction itself, none of this keeps a person from sending something they shouldn't, and in a room that sends images, whatever a picture shows reaches the provider.
