import {
  getMarkdownTheme,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Box, type Component, Markdown, Text } from '@earendil-works/pi-tui';
import { parseMarkdownSections } from './report.js';
import { isRecord } from './utils.js';

export function renderFusionReport(
  message: Pick<Parameters<MessageRenderer>[0], 'content'>,
  options: MessageRenderOptions,
  theme: Pick<Theme, 'fg' | 'bg' | 'bold'>,
): Component | undefined {
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter(
            (block) =>
              isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string',
          )
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
  if (!content.trim()) return undefined;
  const box = new Box(options.outputPad, 1, (text) =>
    theme.bg('customMessageBg', text),
  );
  box.addChild(new Text(theme.fg('accent', theme.bold('Fusion report')), 0, 0));
  box.addChild(
    new Markdown(
      options.expanded ? content : compactReport(content),
      0,
      0,
      getMarkdownTheme(),
    ),
  );
  if (!options.expanded)
    box.addChild(
      new Text(
        theme.fg(
          'dim',
          options.keyHint('app.tools.expand', 'to expand full report'),
        ),
        0,
        0,
      ),
    );
  return box;
}

export function compactReport(content: string): string {
  const sections = parseMarkdownSections(content);
  const summary = sections.get('Summary') ?? content;
  const recommendation = sections.get('Recommendation');
  const counts = (sections.get('Agent Status') ?? '')
    .split('\n')
    .filter((line) =>
      /^- (?:Successful panelists|Failed panelists|Completion quality):/.test(
        line,
      ),
    );
  const metrics = (sections.get('Run Details') ?? '')
    .split('\n')
    .filter((line) =>
      /^- (?:Aggregate model time|Total .*cost[^:]*):/.test(line),
    );
  return [
    firstParagraph(summary),
    ...counts,
    ...(recommendation ? [firstParagraph(recommendation)] : []),
    ...metrics,
  ].join('\n\n');
}

function firstParagraph(text: string): string {
  const paragraph = text.split(/\n\s*\n/, 1)[0]?.trim() ?? '';
  const characters = Array.from(paragraph);
  return characters.length > 400
    ? `${characters.slice(0, 400).join('')}…`
    : paragraph;
}
