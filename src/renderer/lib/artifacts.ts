// When does a turn's stored output deserve a document card in the chat?
// The backend records an artifact for every run (a stored copy of the
// output), so showing one unconditionally puts a "Document" card under
// every reply. A card is only shown when the request itself asks for a
// deliverable: a named file, something "as a document/file/attachment",
// or a create/write/generate verb aimed at a document-like noun.

const FILE_NAME = /\b[\w][\w.-]*\.(?:md|markdown|txt|rtf|pdf|docx?|odt|csv|tsv|json|ya?ml|html?|xml|pptx?|xlsx?)\b/i;
const AS_DELIVERABLE = /\bas an? (?:document|doc|file|attachment|artifact|report)\b/i;
const CREATE_VERB = /\b(?:create|write|generate|produce|make|draft|prepare|export|save|attach|give|send|return|output|compile|build)\b/i;
const DELIVERABLE = /\b(?:artifact|document|doc|report|memo|file|attachment|summary file|markdown|pdf|spreadsheet|slide deck|presentation)\b/i;

export function requestsArtifact(objective: string): boolean {
  if (FILE_NAME.test(objective)) return true;
  if (AS_DELIVERABLE.test(objective)) return true;
  return CREATE_VERB.test(objective) && DELIVERABLE.test(objective);
}
