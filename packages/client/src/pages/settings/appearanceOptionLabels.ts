import type { SettingsIconStyle } from "../../hooks/useSettingsIconStyle";
import type { QuoteReplyButtonMode } from "../../hooks/useQuoteReplyButtonMode";

export function getSettingsIconStyleLabel(
  value: SettingsIconStyle,
  translate: (key: string) => string,
): string {
  switch (value) {
    case "flat":
      return translate("appearanceSettingsIconStyleFlat");
    case "flat-white":
      return translate("appearanceSettingsIconStyleFlatWhite");
    case "emoji":
      return translate("appearanceSettingsIconStyleEmoji");
  }
}

export function getQuoteReplyButtonModeLabel(
  value: QuoteReplyButtonMode,
  translate: (key: string) => string,
): string {
  switch (value) {
    case "block":
      return translate("appearanceQuoteReplyButtonsBlock");
    case "paragraph-hover":
      return translate("appearanceQuoteReplyButtonsParagraphHover");
    case "paragraph-always":
      return translate("appearanceQuoteReplyButtonsParagraphAlways");
  }
}
