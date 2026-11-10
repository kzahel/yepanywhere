import { Button, type ButtonProps } from "./Button";

/** Wrapping, fixed-font filename actions in transcript tool summaries. */
export function FileActionButton(props: ButtonProps) {
  return <Button variant="link" {...props} textFlow="wrap" mono />;
}
