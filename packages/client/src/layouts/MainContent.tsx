import mainStyles from "./MainContent.module.css";
import type { ReactNode, Ref } from "react";

interface MainContentProps {
  children: ReactNode;
  isWideScreen: boolean;
  className?: string;
  innerClassName?: string;
  innerRef?: Ref<HTMLDivElement>;
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function MainContent({
  children,
  isWideScreen,
  className,
  innerClassName,
  innerRef,
}: MainContentProps) {
  return (
    <div
      data-main-content-wrapper={isWideScreen || undefined}
      data-main-content-mobile={!isWideScreen || undefined}
      className={classNames(
        isWideScreen
          ? mainStyles.mainContentWrapper
          : mainStyles.mainContentMobile,
        className,
      )}
    >
      <div
        ref={innerRef}
        data-main-content-constrained={isWideScreen || undefined}
        data-main-content-mobile-inner={!isWideScreen || undefined}
        className={classNames(
          isWideScreen
            ? mainStyles.mainContentConstrained
            : mainStyles.mainContentMobileInner,
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
