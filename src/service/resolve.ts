import {
  ColumnOptions,
  Column as TypeormColumn,
  PrimaryColumn as TypeormPrimaryColumn,
  PrimaryGeneratedColumn as TypeormPrimaryGeneratedColumn
} from 'typeorm'
import { PrimaryGeneratedColumnNumericOptions } from 'typeorm/decorator/options/PrimaryGeneratedColumnNumericOptions';

const columnMapping = {
  char: "text",
  varchar: "text",
  nvarchar: "text",
  text: "text",
  int: "integer",
  tinyint: "integer",
  smallint: "integer",
  datetime: "integer",
  timestamp: "real"
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function Column(columnOptions: ColumnOptions) {
  columnOptions.type = columnMapping[columnOptions.type as string]
  return TypeormColumn(columnOptions)
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function PrimaryColumn(columnOptions: ColumnOptions) {
  columnOptions.type = columnMapping[columnOptions.type as string]
  return TypeormPrimaryColumn(columnOptions)
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function PrimaryGeneratedColumn(
  columnOptions: PrimaryGeneratedColumnNumericOptions
) {
  columnOptions.type = columnMapping[columnOptions.type as string]
  return TypeormPrimaryGeneratedColumn('increment', columnOptions)
}
