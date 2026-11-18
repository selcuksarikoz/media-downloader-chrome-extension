/**
 * Pure geometry for the floating media action group. Shared by the hover
 * controls and the ResizeObserver so both keep controls in the same place.
 */
export function computeActionGroupPosition(rect, width, height, gap, position) {
  let top;
  let left;

  switch (position) {
    case "top-left":
      top = rect.top + gap;
      left = rect.left + gap;
      break;
    case "bottom-left":
      top = rect.bottom - height - gap;
      left = rect.left + gap;
      break;
    case "bottom-right":
      top = rect.bottom - height - gap;
      left = rect.right - width - gap;
      break;
    case "center":
      top = rect.top + (rect.height - height) / 2;
      left = rect.left + (rect.width - width) / 2;
      break;
    default:
      top = rect.top + gap;
      left = rect.right - width - gap;
  }

  return { top: Math.max(0, top), left: Math.max(0, left) };
}
