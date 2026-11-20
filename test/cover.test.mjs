import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSrc } from '../src/cover.mjs';

test('coverSrc：认得的电影页给缩略图地址，别的一律不取', () => {
  assert.deepEqual(coverSrc('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), { img: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' });
  assert.deepEqual(coverSrc('https://youtu.be/dQw4w9WgXcQ'), { img: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' });
  assert.deepEqual(coverSrc('https://www.dailymotion.com/video/x8abcd1'), { img: 'https://www.dailymotion.com/thumbnail/video/x8abcd1' });
  assert.deepEqual(coverSrc('https://archive.org/details/his_girl_friday'), { img: 'https://archive.org/services/img/his_girl_friday' });
  assert.deepEqual(coverSrc('https://www.nfb.ca/film/neighbours_voisins/'), { page: 'https://www.nfb.ca/film/neighbours_voisins/' });
  for (const u of ['https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'https://archive.org/details/../x', 'file:///etc/hosts', 'not a url', '', 'https://www.bilibili.com/video/BV1xx411c7mD'])
    assert.equal(coverSrc(u), null, u);
});
