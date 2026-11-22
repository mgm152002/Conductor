import { useLayoutEffect, useRef, useState } from 'react';

/** The live height of an element, for padding a scroller under a floating composer. */
export function useElementHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setHeight(element.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { setHeight(element.offsetHeight); });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);
  return [ref, height];
}
