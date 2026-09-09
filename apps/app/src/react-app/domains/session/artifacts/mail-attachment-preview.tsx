import { useEffect, useState } from 'react';
import { ImagePreview, PdfPreview, PlainText, PreviewUnavailable } from './preview';
import { readMailPreview, type MailPreviewSource } from './mail-preview-source';

export function MailAttachmentPreview({ sourceId }: { sourceId: string }) {
  const source = readMailPreview(sourceId);
  return source ? <VerifiedPreview key={sourceId} source={source} /> : <PreviewUnavailable />;
}
function VerifiedPreview({ source }: { source: MailPreviewSource }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (source.type === 'text' || source.type === 'word') return;
    const value = URL.createObjectURL(new Blob([source.bytes], { type: source.mime }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [source]);
  return <div className="flex h-full min-h-0 flex-col" aria-label="Stored attachment preview">
    <p className="border-b px-3 py-2 text-xs text-muted-foreground">{source.type === 'word' ? 'Text preview · Read-only' : 'Read-only'}</p>
    <div className="min-h-0 flex-1">{source.type === 'text' || source.type === 'word' ? <PlainText content={new TextDecoder().decode(source.bytes)} /> : !url ? null : source.type === 'pdf' ? <PdfPreview url={url} title={source.name} /> : <ImagePreview src={url} alt={source.name} />}</div>
  </div>;
}
