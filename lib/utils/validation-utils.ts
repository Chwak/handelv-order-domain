/**
 * Utility functions for input validation
 */

export interface ValidationError {
  field: string;
  message: string;
}

export class ValidationException extends Error {
  constructor(
    public errors: ValidationError[],
    message: string = 'Validation failed'
  ) {
    super(message);
    this.name = 'ValidationException';
  }
}

export function validateRequired(
  data: Record<string, any>,
  fields: string[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      errors.push({
        field,
        message: `${field} is required`,
      });
    }
  }

  return errors;
}

export function validateOrThrow(errors: ValidationError[]): void {
  if (errors.length > 0) {
    throw new ValidationException(errors);
  }
}
