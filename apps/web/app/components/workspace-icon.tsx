import type { SVGProps } from "react";

const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  plan: "m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14Z",
  check: "M9 4H5v17h14V4h-4M9 3h6v4H9Zm-1 11 3 3 5-6",
  radar: "M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5m-5 0 8-8M12 12h.01",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  pin: "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  calendar: "M4 5h16v16H4ZM8 2v6m8-6v6M4 11h16",
  file: "M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h5",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  board: "M3 4h7v16H3Zm11 0h7v10h-7Z",
  list: "M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  book: "M12 5C9 2 4 3 2 4v16c3-2 7-2 10 0 3-2 7-2 10 0V4c-2-1-7-2-10 1Zm0 0v15",
} as const;
export type IconName = keyof typeof paths;
export function WorkspaceIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
