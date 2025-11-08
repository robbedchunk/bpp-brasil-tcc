import { SetMetadata } from '@nestjs/common';

// key name we’ll use in the guard
export const IS_PUBLIC_KEY = 'isPublic';

// decorator
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
